import { describe, expect, test } from "bun:test";
import type { TimeseriesRow } from "../src/api";
import { buildDays, dateLabel, level, quartiles } from "../src/contribution";

function row(partial: Partial<TimeseriesRow> & { bucketLabel: string }): TimeseriesRow {
  return {
    bucketStart: 0,
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    userMessages: 0,
    assistantMessages: 0,
    ...partial,
  };
}

describe("buildDays (UTC padded year)", () => {
  test("2026 is a 53-week (371-day) grid", () => {
    const days = buildDays([], Date.UTC(2026, 5, 11));
    expect(days.length).toBe(371);
    expect(Math.ceil(days.length / 7)).toBe(53);
    // Padded start: the Sunday on/before Jan 1.
    expect(new Date(days[0]!.dateMs).getUTCDay()).toBe(0);
    expect(days[0]!.inYear).toBe(false); // Dec 28 2025
  });

  test("2028 needs 54 columns (the COLS-from-data fix)", () => {
    const days = buildDays([], Date.UTC(2028, 11, 31));
    expect(days.length).toBe(378);
    expect(Math.ceil(days.length / 7)).toBe(54);
  });

  test("maps a day row onto the right UTC cell with token totals + top user", () => {
    const days = buildDays(
      [
        row({
          bucketLabel: "2026-06-11",
          events: 7,
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 25,
          cacheReadTokens: 25,
          reasoningTokens: 10,
          costUsd: 1.25,
          byUser: [
            { user: "alice", events: 5, costUsd: 1, userMessages: 2, assistantMessages: 3 },
            { user: "bob", events: 2, costUsd: 0.25, userMessages: 1, assistantMessages: 1 },
          ],
        }),
      ],
      Date.UTC(2026, 5, 15),
    );
    const cell = days.find((d) => d.dateMs === Date.UTC(2026, 5, 11));
    expect(cell).toBeDefined();
    expect(cell!.inYear).toBe(true);
    expect(cell!.messages).toBe(7);
    expect(cell!.tokens).toBe(210);
    expect(cell!.costUsd).toBe(1.25);
    expect(cell!.topUser).toBe("alice"); // most events, not most cost
    expect(cell!.topUserMessages).toBe(5);
  });

  test("rows outside the grid year render as zero cells", () => {
    const days = buildDays([row({ bucketLabel: "2025-12-29", events: 9 })], Date.UTC(2026, 0, 15));
    const cell = days.find((d) => d.dateMs === Date.UTC(2025, 11, 29));
    expect(cell).toBeDefined();
    expect(cell!.inYear).toBe(false);
    expect(cell!.messages).toBe(0);
  });
});

describe("quartiles + level (legacy ramp behavior)", () => {
  test("all-zero days collapse to the [1,1,1,1] cuts", () => {
    expect(quartiles([0, 0, 0])).toEqual([1, 1, 1, 1]);
  });

  test("levels bucket against the non-zero quartiles", () => {
    const cuts = quartiles([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(level(0, cuts)).toBe(0);
    expect(level(1, cuts)).toBe(1);
    expect(level(8, cuts)).toBe(4);
    expect(level(999, cuts)).toBe(4);
  });
});

describe("dateLabel", () => {
  test("renders the UTC date, never local", () => {
    expect(dateLabel(Date.UTC(2026, 5, 11))).toBe("Jun 11, 2026");
    // 1ms before UTC midnight stays on the UTC day.
    expect(dateLabel(Date.UTC(2026, 5, 12) - 1)).toBe("Jun 11, 2026");
  });
});
