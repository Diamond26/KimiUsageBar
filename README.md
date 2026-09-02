# Kimi Usage

A GNOME Shell extension that shows your **Kimi Code** subscription usage right in the top bar: the rolling **5-hour** window and the **weekly** window.

It's the Kimi counterpart to [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage), built the same way: it reads the OAuth token that the `kimi` CLI already stores on your machine and asks Kimi's own usage endpoint how much of your quota is left — no extra login, no scraping, no separate API key.

## What it shows

- **5-hour window** — usage and percentage for Kimi Code's rolling 5-hour quota, with a countdown to reset.
- **Weekly window** — same, for the 7-day quota.

The panel indicator draws a small ring or bar gauge (configurable) and turns green / orange / red depending on how close you are to the limit. Click it for the full breakdown.

## How it works

Kimi Code CLI (`~/.kimi-code`) stores its OAuth access token locally at:

```
~/.kimi-code/credentials/kimi-code.json
```

This extension reads that file and calls:

```
GET https://api.kimi.com/coding/v1/oauth/usage
Authorization: Bearer <access_token>
```

which is the exact same endpoint the Kimi Code CLI itself calls to show you your usage. The response is normalized and rendered in the panel and popup menu, refreshed on a timer (default: every 30 seconds, configurable down to 30s / up to 10 minutes).

## Requirements

- GNOME Shell 45–50 (tested on 50.1, Ubuntu, Wayland)
- The [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) installed and logged in at least once (`kimi`), so that `~/.kimi-code/credentials/kimi-code.json` exists

## Install

```bash
git clone https://github.com/Diamond26/KimiUsageBar.git
ln -s "$(pwd)/KimiUsageBar" ~/.local/share/gnome-shell/extensions/kimi-usage@Diamond26.github.io
glib-compile-schemas ~/.local/share/gnome-shell/extensions/kimi-usage@Diamond26.github.io/schemas
gnome-extensions enable kimi-usage@Diamond26.github.io
```

Then log out and back in (GNOME Shell needs to rescan extensions — on Wayland there's no in-session reload like `Alt+F2 → r`).

## Settings

Open with `gnome-extensions prefs kimi-usage@Diamond26.github.io`, or via the Extensions app. You can configure:

- Refresh interval (30–600 seconds)
- Which gauge to draw in the panel (ring / bar / none)
- Which window the panel gauge reflects (5-hour or weekly)
- Whether to show the percentage label and the reset countdown
- Panel position (left / center / right) and index within that box

## Known limitations

- No automatic token refresh yet — Kimi's refresh-token endpoint isn't publicly documented, so if your access token expires, the extension will tell you to run `kimi` once to re-authenticate rather than guessing at a refresh call.
- Single account only, for now.

## Credits

Inspired by and modeled after [ClaudeCodeUsage](https://github.com/dvdstelt/ClaudeCodeUsage) by [dvdstelt](https://github.com/dvdstelt), which does the same thing for Claude Code / Anthropic.

## License

MIT
