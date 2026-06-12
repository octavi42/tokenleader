import { MAX_TS_MS } from "./db.ts";

/**
 * Shared since/until/period parsing for `/stats/*` and `/api/v1`. Every
 * range is half-open `[since, until)` in unix-ms UTC; all calendar math is
 * UTC; `until` defaults to MAX_TS_MS. `/api/v1` requires `until > since`;
 * `/stats/*` allows `until === since` (degenerate empty).
 */

export const DAY_MS = 86_400_000;

export interface RangeOk {
  since: number;
  until: number;
}

export interface RangeErr {
  error: string;
}

/** Strict unix-ms param: digits only, safe integer, >= 0. Missing/empty →
 *  fallback; malformed (floats, exponents, signs) → null. */
export function parseMsParam(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function floorToMinute(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * Dashboard-route range: `range=<N>d` (N in 1..366, rolling window) or
 * explicit `since`/`until` unix-ms. `range` is floored to the minute so
 * polls within the same minute share a stats-cache key. 400 on range
 * combined with since/until, malformed numbers, or until < since;
 * since === until is allowed. `nowMs` is injectable for tests.
 */
export function parseStatsRange(
  q: URLSearchParams,
  nowMs: number = Date.now(),
): RangeOk | RangeErr {
  const range = q.get("range");
  if (range !== null) {
    if (q.get("since") !== null || q.get("until") !== null) {
      return { error: "range cannot be combined with since/until" };
    }
    const m = /^(\d{1,3})d$/.exec(range);
    const days = m ? Number(m[1]) : 0;
    if (days < 1 || days > 366) {
      return { error: "range must be <N>d with N in 1..366" };
    }
    return { since: floorToMinute(nowMs) - days * DAY_MS, until: MAX_TS_MS };
  }
  const since = parseMsParam(q.get("since") ?? undefined, 0);
  const until = parseMsParam(q.get("until") ?? undefined, MAX_TS_MS);
  if (since === null || until === null) {
    return { error: "since/until must be non-negative integers (unix ms)" };
  }
  if (until < since) {
    return { error: "until must be >= since" };
  }
  return { since, until };
}

/**
 * Parse either:
 *   - `period=YYYY-MM`     → [start of that UTC month, start of next UTC month)
 *   - `period=YYYY-MM-DD`  → [start of that UTC day,   start of next UTC day)
 *   - `since=<v>&until=<v>` where each `<v>` is either a unix-ms integer or
 *     an ISO-8601 datetime (see parseTsInput).
 *
 * Returns `{ since, until }` (both unix-ms, half-open) or `{ error }`.
 */
export function resolveRange(q: URLSearchParams): RangeOk | RangeErr {
  const period = q.get("period");
  if (period) {
    const p = parsePeriod(period);
    if (!p) {
      return {
        error: "period must be YYYY-MM (UTC month) or YYYY-MM-DD (UTC day)",
      };
    }
    return p;
  }
  const sinceRaw = q.get("since");
  const untilRaw = q.get("until");
  if (!sinceRaw || !untilRaw) {
    return {
      error:
        "provide either `period=YYYY-MM`/`period=YYYY-MM-DD` or both `since` and `until` (unix-ms integer or ISO-8601 UTC)",
    };
  }
  const since = parseTsInput(sinceRaw);
  if (since === null) {
    return {
      error: "`since` must be a unix-ms integer or ISO-8601 datetime",
    };
  }
  const until = parseTsInput(untilRaw);
  if (until === null) {
    return {
      error: "`until` must be a unix-ms integer or ISO-8601 datetime",
    };
  }
  if (until <= since) {
    return {
      error: "`until` must be strictly greater than `since` (range is half-open)",
    };
  }
  return { since, until };
}

// Strict subset of the ECMA-262 date-time format: uppercase T/Z only,
// offsets need the colon (±HH:MM), fraction 1-3 digits. Anything looser
// falls into engine-specific Date parsing (JSC vs V8) — keep it closed.
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * `/api/v1` timestamp input: unix-ms integer or strict ISO-8601 datetime.
 * No explicit offset → UTC (never server-local); date-only is UTC midnight.
 * Out-of-format strings → null.
 */
export function parseTsInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Pure-digit string → unix-ms.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) return null;
    return n;
  }
  const m = ISO_DATETIME_RE.exec(trimmed);
  if (!m) return null;
  let s = trimmed;
  // Pad a short fraction to exactly 3 digits so the string is in-format.
  if (m[1] && m[1].length < 4) s = s.replace(m[1], m[1].padEnd(4, "0"));
  // Datetime without offset → append Z: TZ-less ISO is interpreted as UTC.
  if (s.includes("T") && !m[2]) s = s + "Z";
  const n = Date.parse(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `YYYY-MM` → that UTC month; `YYYY-MM-DD` → that UTC day. Half-open. */
export function parsePeriod(raw: string): RangeOk | null {
  const month = /^(\d{4})-(\d{2})$/.exec(raw);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    return {
      since: Date.UTC(y, m - 1, 1),
      until: Date.UTC(y, m, 1),
    };
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) {
    const y = Number(day[1]);
    const m = Number(day[2]);
    const d = Number(day[3]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const since = Date.UTC(y, m - 1, d);
    // Verify the date is real (Date.UTC silently rolls e.g. Feb-30 → Mar-2).
    const back = new Date(since);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
      return null;
    }
    return { since, until: since + DAY_MS };
  }
  return null;
}
