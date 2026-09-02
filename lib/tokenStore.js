import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Pure-ish module for reading Kimi Code's on-disk OAuth credentials. Only
// Gio/GLib are used (no shell UI types), so it stays usable from both the
// extension process and prefs.js.

const decoder = new TextDecoder('utf-8');

// ~/.kimi-code/credentials/kimi-code.json
export function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.kimi-code', 'credentials', 'kimi-code.json']);
}

export class CredentialsError extends Error {
    constructor(message, {missing = false} = {}) {
        super(message);
        this.name = 'CredentialsError';
        // True when there is simply no usable credentials file yet (never
        // signed in, or the CLI hasn't written one) - a state, not a fault.
        this.missing = missing;
    }
}

// Reads and parses Kimi Code's credentials file asynchronously (no
// synchronous file IO on the shell main loop). Resolves to a normalized
// token object, or throws CredentialsError (with .missing = true when the
// file simply isn't there / has no usable token).
export async function readCredentials() {
    const path = credentialsPath();
    const file = Gio.File.new_for_path(path);

    let bytes;
    try {
        bytes = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (f, res) => {
                try {
                    const [ok, data] = f.load_contents_finish(res);
                    resolve(ok ? data : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
            throw new CredentialsError(
                'No Kimi Code credentials found. Run `kimi` once to sign in.', {missing: true});
        }
        throw new CredentialsError(`Could not read Kimi credentials file: ${e.message}`);
    }

    if (!bytes) {
        throw new CredentialsError(
            'No Kimi Code credentials found. Run `kimi` once to sign in.', {missing: true});
    }

    let root;
    try {
        root = JSON.parse(decoder.decode(bytes));
    } catch {
        throw new CredentialsError('Kimi credentials file is malformed (invalid JSON).');
    }

    if (!root?.access_token) {
        throw new CredentialsError(
            'Kimi credentials file has no access token. Run `kimi` to sign in.', {missing: true});
    }

    return {
        accessToken: root.access_token,
        refreshToken: root.refresh_token ?? null,
        // expires_at is documented as unix epoch *seconds*.
        expiresAt: Number(root.expires_at) || 0,
        expiresIn: Number(root.expires_in) || 0,
        scope: root.scope ?? '',
        tokenType: root.token_type ?? 'Bearer',
    };
}

// True when the access token is already expired, or will expire within
// skewSeconds. An unknown/zero expiresAt is treated as "not expired" - we
// let the API itself return 401 rather than guess.
export function isExpired(creds, skewSeconds = 30) {
    if (!creds?.expiresAt)
        return false;
    const nowSeconds = GLib.DateTime.new_now_utc().to_unix();
    return creds.expiresAt - skewSeconds <= nowSeconds;
}
