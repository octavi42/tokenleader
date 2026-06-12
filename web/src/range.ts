/**
 * Date-range pill values:
 *   "7" / "30"  — rolling N-day window (sent as the server-resolved
 *                 `range=<N>d` param so polls share a stats-cache key)
 *   "all"       — lifetime
 *   "YYYY-MM"   — one UTC calendar month
 *
 * Every range is half-open [since, until) in unix-ms UTC — the single
 * contract from src/server/range.ts. Month boundaries are Date.UTC month
 * starts so they line up with the server's strftime UTC buckets.
 */

const RANGE_KEY = "tokenleaderRangeDays";

export interface MonthRange {
  since: number;
  until: number;
}

export function parseMonthRange(v: string): MonthRange | null {
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return { since: Date.UTC(y, mo, 1), until: Date.UTC(y, mo + 1, 1) };
}

/** Exported for the dashboard's ?range= search-param validation (focus
 *  mode shares the URL with the range pills). */
export function isValidRange(v: string): boolean {
  return v === "7" || v === "30" || v === "all" || parseMonthRange(v) !== null;
}

function currentMonthValue(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Current UTC month by default; a saved selection wins across reloads. A
 * saved month outside the trailing-12 window still restores — RangePills
 * prepends an extra pill for it so there is never a selected-nothing state.
 */
export function defaultRange(nowMs: number = Date.now()): string {
  try {
    const saved = localStorage.getItem(RANGE_KEY);
    if (saved && isValidRange(saved)) return saved;
  } catch {
    // storage unavailable (private mode) — fall through
  }
  return currentMonthValue(nowMs);
}

export function persistRange(v: string): void {
  try {
    localStorage.setItem(RANGE_KEY, v);
  } catch {
    // best-effort
  }
}

export interface RangePill {
  value: string;
  label: string;
}

const MONTH_LABELS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/** "JUN" inside the current UTC year, "DEC ’25" outside it. */
export function monthPillLabel(value: string, nowMs: number = Date.now()): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return value;
  const y = Number(m[1]);
  const label = MONTH_LABELS[Number(m[2]) - 1] ?? value;
  if (y === new Date(nowMs).getUTCFullYear()) return label;
  return `${label} ’${String(y % 100).padStart(2, "0")}`;
}

/**
 * 7D / 30D / the CURRENT UTC year's months (Jan through the current month,
 * oldest first) / ALL. Earlier years live under ALL; a persisted/URL month
 * outside the list still restores via RangePills' prepend.
 */
export function rangePills(nowMs: number = Date.now()): RangePill[] {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const curMo = now.getUTCMonth();
  const pills: RangePill[] = [
    { value: "7", label: "7D" },
    { value: "30", label: "30D" },
  ];
  for (let mo = 0; mo <= curMo; mo++) {
    const value = `${y}-${String(mo + 1).padStart(2, "0")}`;
    pills.push({ value, label: monthPillLabel(value, nowMs) });
  }
  pills.push({ value: "all", label: "ALL" });
  return pills;
}

/** Query string for /stats/admin (leading "?", or "" for lifetime).
 *  Months are explicit half-open [since, until) bounds — identical values
 *  to the server's own parsePeriod month math. */
export function rangeQuery(v: string): string {
  if (v === "7" || v === "30") return `?range=${v}d`;
  const month = parseMonthRange(v);
  if (month) return `?since=${month.since}&until=${month.until}`;
  return "";
}
