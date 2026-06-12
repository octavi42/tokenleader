import type { TimeseriesRow } from "./api";

/**
 * Pure day-grid math for the GitHub-style contribution calendar. Everything
 * is UTC: the year runs Jan 1 .. Dec 31 of the year containing `endMs`,
 * padded outward to whole Sun..Sat weeks so the grid is always a full
 * COLS x 7 rectangle. No DOM here — bun-testable.
 */

export const DAY_MS = 86_400_000;

export interface DayCell {
  dateMs: number;
  /** false for the Sun..Sat padding days that belong to adjacent years. */
  inYear: boolean;
  messages: number;
  tokens: number;
  costUsd: number;
  topUser: string | null;
  topUserMessages: number;
}

function dayKey(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function topUserOfDay(row: TimeseriesRow | undefined): { user: string; events: number } | null {
  // /stats/timeseries returns row.byUser only when no user filter is in
  // effect; in focus mode byUser is absent and the tooltip drops its
  // "top:" line. Most events wins; ties break to the first entry.
  if (!row?.byUser || row.byUser.length === 0) return null;
  let best = row.byUser[0]!;
  for (let i = 1; i < row.byUser.length; i++) {
    const u = row.byUser[i]!;
    if (u.events > best.events) best = u;
  }
  return best;
}

/** Full padded-year day list for the year containing endMs (always a
 *  multiple of 7 long). Rows outside the year render as level-0 cells. */
export function buildDays(rows: TimeseriesRow[], endMs: number): DayCell[] {
  const byKey = new Map<string, TimeseriesRow>();
  for (const r of rows) byKey.set(r.bucketLabel, r);
  const year = new Date(endMs).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const dec31 = Date.UTC(year, 11, 31);
  const firstDay = jan1 - new Date(jan1).getUTCDay() * DAY_MS;
  const lastDay = dec31 + (6 - new Date(dec31).getUTCDay()) * DAY_MS;
  const totalDays = Math.floor((lastDay - firstDay) / DAY_MS) + 1;
  const days: DayCell[] = [];
  for (let i = 0; i < totalDays; i++) {
    const ms = firstDay + i * DAY_MS;
    const date = new Date(ms);
    const inYear = date.getUTCFullYear() === year;
    const row = byKey.get(dayKey(date));
    const top = inYear ? topUserOfDay(row) : null;
    days.push({
      dateMs: ms,
      inYear,
      messages: row && inYear ? row.events : 0,
      tokens:
        row && inYear
          ? row.inputTokens +
            row.outputTokens +
            row.cacheCreationTokens +
            row.cacheReadTokens +
            (row.reasoningTokens || 0)
          : 0,
      costUsd: row && inYear ? row.costUsd : 0,
      topUser: top ? top.user : null,
      topUserMessages: top ? top.events : 0,
    });
  }
  return days;
}

/** Quartile cuts over the non-zero day counts. */
export function quartiles(values: number[]): [number, number, number, number] {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return [1, 1, 1, 1];
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))]!;
  return [q(0.25), q(0.5), q(0.75), nz[nz.length - 1]!];
}

/** Ramp level 0..4 for a day count against the quartile cuts. */
export function level(
  v: number,
  cuts: readonly [number, number, number, number],
): 0 | 1 | 2 | 3 | 4 {
  if (v <= 0) return 0;
  if (v <= cuts[0]) return 1;
  if (v <= cuts[1]) return 2;
  if (v <= cuts[2]) return 3;
  return 4;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Jun 11, 2026" (UTC). */
export function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function monthShort(monthIdx: number): string {
  return MONTHS[monthIdx] ?? "";
}
