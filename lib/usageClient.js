import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

// Confirmed endpoint (see kimi-cli-usage-analysis.md): GET .../oauth/usage,
// bearer-token authenticated, JSON response.
export const USAGE_URL = 'https://api.kimi.com/coding/v1/oauth/usage';

const decoder = new TextDecoder('utf-8');

export class UsageError extends Error {
    constructor(message, {status = 0, body = ''} = {}) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.body = body;
    }
}

// Thin libsoup3 client for the Kimi usage endpoint. No token refresh is
// implemented here: Kimi's refresh-token exchange endpoint is not confirmed
// (see lib/tokenStore.js and extension.js for how an expired token is
// surfaced to the user instead of guessed at).
export class UsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    fetchUsage(token, cancellable = null) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', USAGE_URL);
            const headers = msg.get_request_headers();
            headers.append('Authorization', `Bearer ${token}`);
            headers.append('Accept', 'application/json');

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    // Raw status int, not the Soup.Status enum: some codes
                    // (e.g. 429) throw when marshalled through the enum.
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from Kimi usage endpoint`, {status, body: text}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    destroy() {
        this._session = null;
    }
}
