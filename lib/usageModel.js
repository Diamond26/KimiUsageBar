// Pure normalization of Kimi's GET /coding/v1/usages response into a small
// UI-ready shape. Zero GI imports here, so this stays unit-testable under
// plain gjs/node, mirroring the reference ClaudeCodeUsage extension's
// lib/usageModel.js.
//
// Raw response shape (reverse-engineered from the `kimi` CLI binary,
// packages/oauth/src/managed-usage.ts - parseManagedUsagePayload et al.,
// and confirmed live against the real endpoint):
// {
//   usage: {used, limit, remaining, resetTime},   // no window of its own;
//                                                  // the CLI treats this as
//                                                  // the weekly aggregate
//   limits: [{window: {duration, timeUnit}, detail: {used, limit, resetTime}}, ...],
//   boosterWallet: null | {
//     balance: {type, amount, amountLeft, ...},
//     monthlyChargeLimitEnabled, monthlyChargeLimit: {priceInCents, currency},
//     monthlyUsed: {priceInCents, currency},
//   },
// }

function toPercent(used, limit) {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0)
        return null;
    return Math.max(0, Math.min(100, (used / limit) * 100));
}

function toInt(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? Math.trunc(value) : null;
    if (typeof value === 'string') {
        const n = Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    return null;
}

// resetTime is documented as an ISO-8601 datetime string, but we parse
// defensively: also accept a raw unix-seconds number (or numeric string).
// Returns an ISO string, or null if it can't be parsed at all.
export function normalizeResetAt(resetAt) {
    if (resetAt === null || resetAt === undefined || resetAt === '')
        return null;

    if (typeof resetAt === 'number' && Number.isFinite(resetAt))
        return new Date(resetAt * 1000).toISOString();

    if (typeof resetAt === 'string') {
        const trimmed = resetAt.trim();
        if (/^\d+$/.test(trimmed)) {
            // Pure digits: unix seconds (support a millisecond timestamp too,
            // in case of an even larger integer).
            const n = Number(trimmed);
            const ms = trimmed.length >= 13 ? n : n * 1000;
            return new Date(ms).toISOString();
        }
        const parsed = Date.parse(trimmed);
        if (!Number.isNaN(parsed))
            return new Date(parsed).toISOString();
    }

    return null;
}

// {duration, timeUnit: "TIME_UNIT_MINUTE"|"TIME_UNIT_HOUR"|"TIME_UNIT_DAY"|"TIME_UNIT_WEEK"}
// -> {duration, unit: "hour"|"minute"|"day"|"week"}, collapsing a
// minutes-window that's an even number of hours (e.g. 300 minutes -> 5
// hours) since that's how the 5-hour window is actually reported.
function normalizeWindow(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const duration = toInt(raw.duration);
    const unitMap = {
        TIME_UNIT_MINUTE: 'minute',
        TIME_UNIT_HOUR: 'hour',
        TIME_UNIT_DAY: 'day',
        TIME_UNIT_WEEK: 'week',
    };
    const unit = unitMap[raw.timeUnit] ?? null;
    if (duration === null || unit === null)
        return null;
    if (unit === 'minute' && duration >= 60 && duration % 60 === 0)
        return {duration: duration / 60, unit: 'hour'};
    return {duration, unit};
}

// Builds a {used, limit, percent, resetsAt} row from a {used, limit,
// resetTime} object (either the top-level `usage`, or a `limits[].detail`).
function toRow(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const used = toInt(raw.used);
    const limit = toInt(raw.limit);
    if (used === null && limit === null)
        return null;
    return {
        used: used ?? 0,
        limit: limit ?? 0,
        percent: toPercent(used ?? 0, limit ?? 0),
        resetsAt: normalizeResetAt(raw.resetTime ?? null),
    };
}

// The rolling 5-hour window: limits[] entry whose window normalizes to
// {duration: 5, unit: "hour"}.
function findFiveHour(limits) {
    return limits.find(i => i.window?.duration === 5 && i.window?.unit === 'hour') ?? null;
}

// The weekly window: an explicit limits[] entry with window.unit === "week",
// falling back to the top-level `usage` object, which the CLI itself treats
// as the weekly aggregate when it carries no window of its own.
function findWeekly(limits, summaryRow) {
    return limits.find(i => i.window?.unit === 'week') ?? summaryRow;
}

// Normalizes the raw /usages response into {fiveHour, weekly, monthlyBudget}
// where fiveHour/weekly are {used, limit, percent, resetsAt} or null, and
// monthlyBudget is {enabled, usedCents, limitCents, percent} or null (null
// whenever boosterWallet is absent or the monthly cap is disabled - there is
// no real monthly token-quota window in Kimi's data model, only this
// dollar-based overage budget).
export function normalizeUsage(raw) {
    const rawLimits = Array.isArray(raw?.limits) ? raw.limits : [];
    const limits = rawLimits
        .map(item => {
            const row = toRow(item?.detail);
            if (!row)
                return null;
            return {...row, window: normalizeWindow(item?.window)};
        })
        .filter(Boolean);

    const summaryRow = toRow(raw?.usage);

    const fiveHour = findFiveHour(limits);
    const weekly = findWeekly(limits, summaryRow);

    let monthlyBudget = null;
    const wallet = raw?.boosterWallet;
    if (wallet && wallet.monthlyChargeLimitEnabled) {
        const usedCents = toInt(wallet.monthlyUsed?.priceInCents);
        const limitCents = toInt(wallet.monthlyChargeLimit?.priceInCents);
        monthlyBudget = {
            enabled: true,
            usedCents,
            limitCents,
            percent: toPercent(usedCents, limitCents),
        };
    }

    const dropWindow = row => row ? {used: row.used, limit: row.limit, percent: row.percent, resetsAt: row.resetsAt} : null;

    return {
        fiveHour: dropWindow(fiveHour),
        weekly: dropWindow(weekly),
        monthlyBudget,
    };
}

// Formats a cents integer as e.g. "$3.20". Returns an em dash for anything
// that isn't a finite number.
export function formatCents(cents) {
    if (!Number.isFinite(cents))
        return '—';
    return `$${(cents / 100).toFixed(2)}`;
}
