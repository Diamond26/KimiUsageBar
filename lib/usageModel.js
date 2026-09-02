// Pure normalization of Kimi's GET /oauth/usage response into a small
// UI-ready shape. Zero GI imports here, so this stays unit-testable under
// plain gjs/node, mirroring the reference ClaudeCodeUsage extension's
// lib/usageModel.js.
//
// Raw response shape (see kimi-cli-usage-analysis.md):
// {
//   summary: null | {name, window:{duration,unit}, used, limit, reset_at},
//   limits: [{name, window:{duration,unit}, used, limit, reset_at}, ...],
//   extra_usage: null | {balance_cents, total_cents,
//     monthly_charge_limit_enabled, monthly_charge_limit_cents, monthly_used_cents}
// }

function toPercent(used, limit) {
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0)
        return null;
    return Math.max(0, Math.min(100, (used / limit) * 100));
}

// reset_at is documented as an ISO-8601 datetime string, but we parse
// defensively: also accept a raw unix-seconds number (or numeric string),
// in case a given plan/window returns it that way. Returns an ISO string,
// or null if it can't be parsed at all.
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

function normalizeWindow(entry) {
    if (!entry)
        return null;
    const used = Number(entry.used);
    const limit = Number(entry.limit);
    return {
        name: entry.name ?? '',
        used: Number.isFinite(used) ? used : null,
        limit: Number.isFinite(limit) ? limit : null,
        percent: toPercent(used, limit),
        resetsAt: normalizeResetAt(entry.reset_at ?? entry.resetAt ?? null),
    };
}

// The rolling 5-hour window: limits[] entry with window = {duration: 5, unit: "hour"}.
function findFiveHour(limits) {
    return limits.find(i => i?.window?.duration === 5 && i?.window?.unit === 'hour') ?? null;
}

// The weekly window: limits[] entry with window.unit === "week".
function findWeekly(limits) {
    return limits.find(i => i?.window?.unit === 'week') ?? null;
}

// Normalizes the raw /oauth/usage response into
// {fiveHour, weekly, monthlyBudget} where fiveHour/weekly are
// {name, used, limit, percent, resetsAt} or null, and monthlyBudget is
// {enabled, usedCents, limitCents, percent, balanceCents, totalCents} or
// null (null whenever extra_usage is null or the monthly cap is disabled -
// there is no real monthly token-quota window in Kimi's data model, only
// this dollar-based overage budget).
export function normalizeUsage(raw) {
    const limits = Array.isArray(raw?.limits) ? raw.limits : [];

    // Fall back to `summary` if for some reason the matching window isn't in
    // limits[] but is what the API chose to summarize.
    const summaryIsFiveHour = raw?.summary?.window?.duration === 5 && raw?.summary?.window?.unit === 'hour';
    const summaryIsWeekly = raw?.summary?.window?.unit === 'week';

    const fiveHourRaw = findFiveHour(limits) ?? (summaryIsFiveHour ? raw.summary : null);
    const weeklyRaw = findWeekly(limits) ?? (summaryIsWeekly ? raw.summary : null);

    const fiveHour = normalizeWindow(fiveHourRaw);
    const weekly = normalizeWindow(weeklyRaw);

    let monthlyBudget = null;
    const extra = raw?.extra_usage;
    if (extra && extra.monthly_charge_limit_enabled) {
        const usedCents = Number(extra.monthly_used_cents);
        const limitCents = Number(extra.monthly_charge_limit_cents);
        const balanceCents = Number(extra.balance_cents);
        const totalCents = Number(extra.total_cents);
        monthlyBudget = {
            enabled: true,
            usedCents: Number.isFinite(usedCents) ? usedCents : null,
            limitCents: Number.isFinite(limitCents) ? limitCents : null,
            percent: toPercent(usedCents, limitCents),
            balanceCents: Number.isFinite(balanceCents) ? balanceCents : null,
            totalCents: Number.isFinite(totalCents) ? totalCents : null,
        };
    }

    return {fiveHour, weekly, monthlyBudget};
}

// Formats a cents integer as e.g. "$3.20". Returns an em dash for anything
// that isn't a finite number.
export function formatCents(cents) {
    if (!Number.isFinite(cents))
        return '—';
    return `$${(cents / 100).toFixed(2)}`;
}
