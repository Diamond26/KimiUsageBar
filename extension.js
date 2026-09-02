import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {readCredentials, isExpired, CredentialsError} from './lib/tokenStore.js';
import {UsageClient, UsageError} from './lib/usageClient.js';
import {normalizeUsage, formatCents} from './lib/usageModel.js';

// Severity levels, least to most severe.
const LEVEL_RANK = {ok: 0, warn: 1, crit: 2};

function utilLevel(util) {
    if (!Number.isFinite(util))
        return 'ok';
    if (util >= 90)
        return 'crit';
    if (util >= 75)
        return 'warn';
    return 'ok';
}

function levelClass(level) {
    return `ku-${level}`;
}

function levelRgb(level) {
    if (level === 'crit')
        return [0.88, 0.11, 0.14]; // #e01b24
    if (level === 'warn')
        return [1.0, 0.47, 0.0];   // #ff7800
    return [0.2, 0.82, 0.48];      // #33d17a
}

const RING_SIZE = 18;
const RING_WIDTH = 3;
const PANEL_BAR_WIDTH = 34;

// StThemeNode colors are Cogl.Color; across GNOME Shell versions the
// components come back either as 0-255 bytes or as 0-1 floats, so detect
// the scale instead of assuming one.
function colorRgb(c) {
    const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
    return [c.red / scale, c.green / scale, c.blue / scale];
}

// Collapse refreshes that land closer together than this floor (popup-open
// and the poll timer can otherwise fire back-to-back).
const MIN_REFRESH_MS = 60 * 1000;

function relativeReset(iso) {
    if (!iso)
        return '';
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'resetting…';
    if (diff < 60000)
        return `resets in ${Math.floor(diff / 1000)}s`;
    const mins = Math.round(diff / 60000);
    if (mins < 60)
        return `resets in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `resets in ${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `resets in ${days}d ${hrs % 24}h`;
}

// Compact "time until reset" for the panel: magnitude only, e.g. "4h21m".
function compactReset(iso) {
    if (!iso)
        return '';
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    const diff = target - Date.now();
    if (diff <= 0)
        return 'now';
    const s = Math.max(0, Math.floor(diff / 1000));
    if (s < 60)
        return `${s}s`;
    const mins = Math.round(s / 60);
    if (mins < 60)
        return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d${hrs % 24}h`;
}

function wrapLabel(label) {
    label.x_expand = true;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// A labelled progress meter: title + percentage row, bar, and caption.
class Meter {
    constructor(name) {
        this.root = new St.BoxLayout({vertical: true, style_class: 'ku-meter'});

        const row = new St.BoxLayout({style_class: 'ku-meter-row'});
        this._name = new St.Label({text: name, style_class: 'ku-meter-name', x_expand: true});
        this._pct = new St.Label({text: '—', style_class: 'ku-meter-pct'});
        row.add_child(this._name);
        row.add_child(this._pct);

        this._track = new St.BoxLayout({style_class: 'ku-track', x_expand: true});
        this._fill = new St.Widget({style_class: 'ku-fill ku-ok'});
        this._track.add_child(this._fill);
        this._fraction = 0;
        this._track.connectObject('notify::width', () => this._resizeFill(), this);

        this._caption = wrapLabel(new St.Label({text: '', style_class: 'ku-caption'}));

        this.root.add_child(row);
        this.root.add_child(this._track);
        this.root.add_child(this._caption);
    }

    setValue(util, caption, level = utilLevel(util)) {
        this._pct.text = `${Math.round(util)}%`;
        this._fraction = Math.max(0, Math.min(100, util)) / 100;
        this._resizeFill();
        this._fill.style_class = `ku-fill ${levelClass(level)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    setPctText(text, caption, level = 'ok') {
        this._pct.text = text;
        this._fraction = 0;
        this._resizeFill();
        this._fill.style_class = `ku-fill ${levelClass(level)}`;
        this._caption.text = caption ?? '';
        this._caption.visible = !!caption;
    }

    _resizeFill() {
        const w = this._track?.get_width() ?? 0;
        this._fill.set_width(Math.round(this._fraction * w));
    }

    setName(name) {
        this._name.text = name;
    }

    setMuted() {
        this._pct.text = '—';
        this._fraction = 0;
        this._fill.set_width(0);
        this._caption.visible = false;
    }

    destroy() {
        this._track?.disconnectObject(this);
        this._name?.destroy();
        this._pct?.destroy();
        this._fill?.destroy();
        this._caption?.destroy();
        this._track?.destroy();
        this.root?.destroy();
        this._name = null;
        this._pct = null;
        this._fill = null;
        this._caption = null;
        this._track = null;
        this.root = null;
    }
}

// A compact circular usage gauge for the panel, drawn with Cairo.
const Ring = GObject.registerClass(
class Ring extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'ku-ring',
            width: RING_SIZE,
            height: RING_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._util = null;
        this._color = null;
    }

    setValue(util, level = utilLevel(util)) {
        this._util = Math.max(0, Math.min(100, util));
        this._color = levelRgb(level);
        this.queue_repaint();
    }

    setUnknown() {
        this._util = null;
        this._color = null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) / 2 - RING_WIDTH / 2;
        const start = -Math.PI / 2;

        cr.setLineWidth(RING_WIDTH);
        cr.setLineCap(Cairo.LineCap.ROUND);

        const [fr, fg, fb] = colorRgb(this.get_theme_node().get_foreground_color());
        cr.setSourceRGBA(fr, fg, fb, 0.22);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._util !== null && this._util > 0) {
            const [r, g, b] = this._color ?? levelRgb(utilLevel(this._util));
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(cx, cy, radius, start, start + (this._util / 100) * 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }
});

// A compact horizontal usage bar for the panel: mirrors Ring's API.
class PanelBar {
    constructor() {
        this.root = new St.BoxLayout({
            style_class: 'ku-panel-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'ku-panel-bar-fill'});
        this.root.add_child(this._fill);
    }

    setValue(util, level = utilLevel(util)) {
        const clamped = Math.max(0, Math.min(100, util));
        this._fill.set_width(Math.round((clamped / 100) * PANEL_BAR_WIDTH));
        this._fill.style_class = `ku-panel-bar-fill ${levelClass(level)}`;
    }

    setUnknown() {
        this._fill.set_width(0);
        this._fill.style_class = 'ku-panel-bar-fill';
    }

    destroy() {
        this._fill?.destroy();
        this.root?.destroy();
        this._fill = null;
        this.root = null;
    }
}

const KimiUsageIndicator = GObject.registerClass(
class KimiUsageIndicator extends PanelMenu.Button {
    _init(settings, openPreferences, iconPath) {
        super._init(0.5, 'Kimi Usage');

        this._settings = settings;
        this._openPreferences = openPreferences;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._lastFetchMs = 0;
        this._client = new UsageClient();
        this._lastUsage = null; // {fiveHour, weekly, monthlyBudget}
        this._lastResult = null; // 'ok' | 'error' | 'signed-out'
        this._countdownTimer = null;
        this._timer = null;
        this._meters = new Map(); // key -> Meter
        this._meterBindings = []; // [{meter, key, window}]

        // ---- panel button ----
        this._panelBox = new St.BoxLayout({style_class: 'ku-panel'});
        this._panelIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            icon_size: 16,
            style_class: 'system-status-icon ku-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ring = new Ring();
        this._panelBar = new PanelBar();
        this._panelText = new St.Label({text: '…', style_class: 'ku-panel-text', y_align: Clutter.ActorAlign.CENTER});
        this._panelReset = new St.Label({text: '', style_class: 'ku-panel-reset', y_align: Clutter.ActorAlign.CENTER});
        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._ring);
        this._panelBox.add_child(this._panelBar.root);
        this._panelBox.add_child(this._panelText);
        this._panelBox.add_child(this._panelReset);
        this.add_child(this._panelBox);

        this._buildMenuShell();

        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        }, this);

        this._settings.connectObject(
            'changed::show-icon', () => this._applyVisibility(),
            'changed::panel-gauge', () => this._applyVisibility(),
            'changed::show-percentage', () => this._applyVisibility(),
            'changed::show-reset', () => this._applyVisibility(),
            'changed::show-monthly-budget', () => this._render(this._lastUsage),
            'changed::panel-window', () => this._renderPanel(),
            'changed::poll-seconds', () => this._startTimer(),
            this);

        this._applyVisibility();
        this._refresh(true);
        this._startTimer();
    }

    _buildMenuShell() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const root = new St.BoxLayout({vertical: true, style_class: 'ku-popup'});
        item.add_child(root);
        this.menu.addMenuItem(item);

        const header = new St.BoxLayout({style_class: 'ku-header'});
        const who = new St.BoxLayout({vertical: true, x_expand: true});
        this._title = new St.Label({text: 'Kimi Usage', style_class: 'ku-title'});
        this._subtitle = new St.Label({text: '', style_class: 'ku-subtitle'});
        who.add_child(this._title);
        who.add_child(this._subtitle);
        header.add_child(who);
        root.add_child(header);

        this._metersBox = new St.BoxLayout({vertical: true});
        root.add_child(this._metersBox);

        this._error = wrapLabel(new St.Label({text: '', style_class: 'ku-error'}));
        this._error.visible = false;
        root.add_child(this._error);

        const footer = new St.BoxLayout({style_class: 'ku-footer'});
        this._updated = new St.Label({text: 'Loading…', style_class: 'ku-updated', x_expand: true});
        footer.add_child(this._updated);
        const settingsBtn = new St.Button({label: '⚙ Settings', style_class: 'ku-refresh', x_expand: true});
        settingsBtn.connect('clicked', () => {
            this.menu.close();
            this._openPreferences?.();
        });
        this._refreshBtn = new St.Button({label: '↻ Refresh', style_class: 'ku-refresh', x_expand: true});
        this._refreshBtn.connectObject('clicked', () => this._refresh(true), this);
        footer.add_child(settingsBtn);
        footer.add_child(this._refreshBtn);
        root.add_child(footer);
    }

    _applyVisibility() {
        this._panelIcon.visible = this._settings.get_boolean('show-icon');
        const gauge = this._settings.get_string('panel-gauge');
        this._ring.visible = gauge === 'ring';
        this._panelBar.root.visible = gauge === 'bar';
        this._panelText.visible = this._settings.get_boolean('show-percentage');
        this._panelReset.visible = this._settings.get_boolean('show-reset');
    }

    _startTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        const seconds = this._settings.get_int('poll-seconds');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh(force = false) {
        if (this._busy)
            return;
        if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS)
            return;
        this._busy = true;
        this._lastFetchMs = Date.now();

        const cancellable = this._cancellable;
        this._fetchAndRender(cancellable).finally(() => {
            this._busy = false;
            if (cancellable.is_cancelled())
                return;
            this._renderUpdatedAt();
            this._scheduleCountdown();
        });
    }

    async _fetchAndRender(cancellable) {
        let creds;
        try {
            creds = await readCredentials();
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            this._renderCredentialsError(e);
            return;
        }
        if (cancellable.is_cancelled())
            return;

        if (isExpired(creds)) {
            this._renderExpired();
            return;
        }

        try {
            const raw = await this._client.fetchUsage(creds.accessToken, cancellable);
            if (cancellable.is_cancelled())
                return;
            const usage = normalizeUsage(raw);
            this._render(usage);
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            this._renderFetchError(e);
        }
    }

    _render(usage) {
        if (!usage)
            return;
        this._error.visible = false;
        this._lastUsage = usage;
        this._subtitle.text = 'Signed in';

        const rows = [];
        if (usage.fiveHour)
            rows.push({key: 'five-hour', label: '5-hour limit', window: usage.fiveHour, kind: 'percent'});
        if (usage.weekly)
            rows.push({key: 'weekly', label: 'Weekly limit', window: usage.weekly, kind: 'percent'});
        if (usage.monthlyBudget?.enabled && this._settings.get_boolean('show-monthly-budget'))
            rows.push({key: 'monthly', label: 'Monthly overage budget', window: usage.monthlyBudget, kind: 'currency'});

        this._meterBindings = [];
        const seen = new Set();
        for (const row of rows) {
            seen.add(row.key);
            let meter = this._meters.get(row.key);
            if (!meter) {
                meter = new Meter(row.label);
                this._metersBox.add_child(meter.root);
                this._meters.set(row.key, meter);
            } else {
                meter.setName(row.label);
            }
            this._applyRow(meter, row);
            this._meterBindings.push(row);
        }
        rows.forEach((row, i) => {
            this._metersBox.set_child_at_index(this._meters.get(row.key).root, i);
        });
        for (const [key, meter] of this._meters) {
            if (!seen.has(key)) {
                meter.destroy();
                this._meters.delete(key);
            }
        }

        if (rows.length === 0) {
            this._error.text = 'Kimi returned no usage windows for this account.';
            this._error.style_class = 'ku-error ku-dim';
            this._error.visible = true;
        }

        this._renderPanel();
        this._lastResult = 'ok';
    }

    _applyRow(meter, row) {
        if (row.kind === 'currency') {
            const mb = row.window;
            if (mb.usedCents === null || mb.limitCents === null) {
                meter.setMuted();
                return;
            }
            const level = utilLevel(mb.percent ?? 0);
            const text = `${formatCents(mb.usedCents)} / ${formatCents(mb.limitCents)}`;
            meter.setPctText(mb.percent !== null ? `${Math.round(mb.percent)}%` : '—', text, level);
            return;
        }
        const w = row.window;
        if (!w || w.percent === null) {
            meter.setMuted();
            return;
        }
        const level = utilLevel(w.percent);
        const caption = w.resetsAt ? relativeReset(w.resetsAt) : '';
        meter.setValue(w.percent, caption, level);
    }

    _renderPanel() {
        const usage = this._lastUsage;
        if (!usage) {
            this._panelText.text = '—';
            this._panelText.style_class = 'ku-panel-text';
            this._ring.setUnknown();
            this._panelBar.setUnknown();
            this._panelReset.text = '';
            return;
        }

        const which = this._settings.get_string('panel-window');
        const primary = which === 'weekly' ? usage.weekly : usage.fiveHour;

        if (primary && primary.percent !== null) {
            const level = utilLevel(primary.percent);
            this._panelText.text = `${Math.round(primary.percent)}%`;
            this._panelText.style_class = `ku-panel-text ${levelClass(level)}`;
            this._ring.setValue(primary.percent, level);
            this._panelBar.setValue(primary.percent, level);
            this._panelReset.text = primary.resetsAt ? compactReset(primary.resetsAt) : '';
        } else {
            this._panelText.text = '—';
            this._panelText.style_class = 'ku-panel-text';
            this._ring.setUnknown();
            this._panelBar.setUnknown();
            this._panelReset.text = '';
        }
    }

    _renderUpdatedAt() {
        if (!this._updated)
            return;
        if (this._lastResult === 'ok') {
            const now = GLib.DateTime.new_now_local();
            this._updated.text = `Updated ${now.format('%H:%M:%S')}`;
        } else if (this._lastResult === 'error') {
            this._updated.text = 'Update failed';
        } else {
            this._updated.text = '';
        }
    }

    // Soonest reset among the currently shown windows, in seconds, or null.
    _soonestResetSeconds() {
        let soonest = null;
        const usage = this._lastUsage;
        if (!usage)
            return null;
        for (const w of [usage.fiveHour, usage.weekly]) {
            if (!w?.resetsAt)
                continue;
            const t = Date.parse(w.resetsAt);
            if (Number.isNaN(t))
                continue;
            const rem = (t - Date.now()) / 1000;
            if (rem > 0 && (soonest === null || rem < soonest))
                soonest = rem;
        }
        return soonest;
    }

    _scheduleCountdown() {
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        const soonest = this._soonestResetSeconds();
        if (soonest === null)
            return;
        const interval = soonest < 90 ? 1 : 30;
        this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._countdownTimer = null;
            if (this._lastUsage) {
                for (const row of this._meterBindings)
                    this._applyRow(this._meters.get(row.key), row);
                this._renderPanel();
            }
            this._scheduleCountdown();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Missing/malformed credentials file: not a network failure, just a
    // "not signed in" state.
    _renderCredentialsError(e) {
        this._clearMeters();
        this._subtitle.text = e instanceof CredentialsError && e.missing ? 'Not signed in' : 'Credentials error';
        this._panelText.text = '—';
        this._panelText.style_class = 'ku-panel-text';
        this._ring.setUnknown();
        this._panelBar.setUnknown();
        this._panelReset.text = '';
        this._error.text = e.message ?? 'Kimi credentials not found. Run `kimi` to sign in.';
        this._error.style_class = 'ku-error ku-dim';
        this._error.visible = true;
        this._lastResult = 'signed-out';
    }

    // The access token in the credentials file is expired. We deliberately do
    // NOT guess at a token-refresh endpoint (Kimi's refresh flow isn't
    // confirmed) - the CLI itself refreshes the file on its next use.
    _renderExpired() {
        this._clearMeters();
        this._subtitle.text = 'Token expired';
        this._panelText.text = '!';
        this._panelText.style_class = 'ku-panel-text ku-warn';
        this._ring.setUnknown();
        this._panelBar.setUnknown();
        this._panelReset.text = '';
        this._error.text = 'Kimi access token expired. Run `kimi` once to refresh it, then Refresh here.';
        this._error.style_class = 'ku-error';
        this._error.visible = true;
        this._lastResult = 'error';
    }

    _renderFetchError(e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        // A transient rate limit: keep showing stale data if we have it.
        if (e instanceof UsageError && e.status === 429 && this._lastUsage) {
            logError(e, 'kimi-usage: rate limited, keeping last data');
            return;
        }
        this._panelText.text = '!';
        this._panelText.style_class = 'ku-panel-text ku-warn';
        this._ring.setUnknown();
        this._panelBar.setUnknown();
        this._panelReset.text = '';
        let msg;
        if (e instanceof UsageError && e.status === 401)
            msg = 'Session expired. Run `kimi` to re-authenticate.';
        else if (e instanceof UsageError && e.status === 429)
            msg = 'Rate limited by Kimi; will retry shortly.';
        else
            msg = e.message || 'Could not reach Kimi';
        this._subtitle.text = 'Error';
        this._error.text = msg;
        this._error.style_class = 'ku-error';
        this._error.visible = true;
        this._lastResult = 'error';
        logError(e, 'kimi-usage: refresh failed');
    }

    _clearMeters() {
        for (const meter of this._meters.values())
            meter.destroy();
        this._meters.clear();
        this._meterBindings = [];
        this._lastUsage = null;
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._countdownTimer) {
            GLib.source_remove(this._countdownTimer);
            this._countdownTimer = null;
        }
        this.menu.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._settings = null;

        this._client?.destroy();
        this._client = null;

        this._clearMeters();

        this._updated?.destroy();
        this._updated = null;
        this._refreshBtn?.disconnectObject(this);
        this._refreshBtn?.destroy();
        this._refreshBtn = null;

        this._ring?.destroy();
        this._panelBar?.destroy();
        this._panelIcon?.destroy();
        this._panelText?.destroy();
        this._panelReset?.destroy();
        this._panelBox?.destroy();
        this._title?.destroy();
        this._subtitle?.destroy();
        this._metersBox?.destroy();
        this._error?.destroy();

        this._ring = null;
        this._panelBar = null;
        this._panelIcon = null;
        this._panelText = null;
        this._panelReset = null;
        this._panelBox = null;
        this._title = null;
        this._subtitle = null;
        this._metersBox = null;
        this._error = null;

        super.destroy();
    }
});

export default class KimiUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const iconPath = GLib.build_filenamev([this.path, 'icons', 'kimi-symbolic.svg']);
        this._indicator = new KimiUsageIndicator(this._settings, () => this.openPreferences(), iconPath);

        this._settings.connectObject(
            'changed::panel-position', () => this._place(),
            'changed::panel-index', () => this._place(),
            this);
        this._place();
    }

    _place() {
        if (Main.panel.statusArea[this.uuid])
            Main.panel.statusArea[this.uuid] = null;
        Main.panel.addToStatusArea(
            this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
