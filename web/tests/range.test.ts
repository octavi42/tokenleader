import { describe, expect, test } from "bun:test";
import { monthPillLabel, parseMonthRange, rangePills, rangeQuery } from "../src/range";

describe("parseMonthRange", () => {
  test("YYYY-MM → half-open UTC month bounds", () => {
    expect(parseMonthRange("2026-06")).toEqual({
      since: Date.UTC(2026, 5, 1),
      until: Date.UTC(2026, 6, 1),
    });
  });

  test("December rolls the until into the next year", () => {
    expect(parseMonthRange("2025-12")).toEqual({
      since: Date.UTC(2025, 11, 1),
      until: Date.UTC(2026, 0, 1),
    });
  });

  test("rejects malformed values (the \\d-class regression guard)", () => {
    expect(parseMonthRange("206-06")).toBeNull();
    expect(parseMonthRange("2026-13")).toBeNull();
    expect(parseMonthRange("2026-00")).toBeNull();
    expect(parseMonthRange("all")).toBeNull();
  });
});

describe("rangeQuery (half-open, matching src/server/range.ts)", () => {
  test("months send explicit since/until — until is EXCLUSIVE next-month start", () => {
    expect(rangeQuery("2026-06")).toBe(
      `?since=${Date.UTC(2026, 5, 1)}&until=${Date.UTC(2026, 6, 1)}`,
    );
  });

  test("rolling windows resolve server-side via range=<N>d", () => {
    expect(rangeQuery("7")).toBe("?range=7d");
    expect(rangeQuery("30")).toBe("?range=30d");
  });

  test("ALL is lifetime — no params", () => {
    expect(rangeQuery("all")).toBe("");
  });
});

describe("rangePills (current-year months)", () => {
  test("mid-year: 7D/30D + Jan..current month + ALL", () => {
    const pills = rangePills(Date.UTC(2026, 5, 15)); // Jun 15 2026
    expect(pills.length).toBe(9); // 7D, 30D, JAN..JUN, ALL
    expect(pills[0]).toEqual({ value: "7", label: "7D" });
    expect(pills[1]).toEqual({ value: "30", label: "30D" });
    expect(pills[2]).toEqual({ value: "2026-01", label: "JAN" });
    expect(pills[7]).toEqual({ value: "2026-06", label: "JUN" });
    expect(pills[8]).toEqual({ value: "all", label: "ALL" });
  });

  test("January: only the current month shows; prior year lives under ALL", () => {
    const pills = rangePills(Date.UTC(2026, 0, 5)); // Jan 5 2026
    const values = pills.map((p) => p.value);
    expect(values).toEqual(["7", "30", "2026-01", "all"]);
    const jan = pills.find((p) => p.value === "2026-01");
    expect(jan?.label).toBe("JAN");
  });

  test("months are contiguous from January of the current UTC year", () => {
    const pills = rangePills(Date.UTC(2026, 2, 1)); // Mar 2026
    const months = pills.map((p) => p.value).filter((v) => /^\d{4}-\d{2}$/.test(v));
    expect(months).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("monthPillLabel", () => {
  test("current year is bare; prior year gets the ’YY suffix", () => {
    const now = Date.UTC(2026, 5, 15);
    expect(monthPillLabel("2026-06", now)).toBe("JUN");
    expect(monthPillLabel("2025-12", now)).toBe("DEC ’25");
    expect(monthPillLabel("2024-03", now)).toBe("MAR ’24");
  });
});
