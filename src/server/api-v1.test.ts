import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, jsonOf, makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import { resolveRange } from "./api-v1.ts";
import { buildApp } from "./main.ts";

// All seed events use claude-sonnet-4-5 so cost calculations exercise the
// PricingCache against a real entry in pricing-fallback.json. Per-event
// numbers are tiny but real — we assert on relative ordering rather than
// absolute cents so a pricing-table refresh can't break the suite.
const MODEL = "claude-sonnet-4-5";

// UTC fixtures. May 2026 has 31 days; June 1 00:00 UTC is the exclusive
// upper bound for the month period.
const MAY_1_UTC = Date.UTC(2026, 4, 1); // 2026-05-01T00:00:00Z
const MAY_15_UTC = Date.UTC(2026, 4, 15); // 2026-05-15T00:00:00Z
const JUN_1_UTC = Date.UTC(2026, 5, 1); // 2026-06-01T00:00:00Z

const API_TOKEN = "test-api-token-zzzz";

let openApp: ReturnType<typeof buildApp>["app"];
let authedApp: ReturnType<typeof buildApp>["app"];
let cleanups: Array<() => Promise<void>> = [];

const makeEvent = (over: Partial<TokenEvent> = {}): TokenEvent =>
  makeTokenEvent({ timestamp: MAY_15_UTC, model: MODEL, ...over });

beforeAll(() => {
  // Two app instances: open (no apiToken) and authed (apiToken set).
  // Each gets its own SQLite file so they don't share state.
  const open = createTestApp();
  const authed = createTestApp({ apiToken: API_TOKEN });
  openApp = open.app;
  authedApp = authed.app;
  cleanups.push(open.cleanup, authed.cleanup);

  // Seed identical data into both stores. Eight events scattered across
  // April, May, and the boundary, with three distinct users.
  const events: TokenEvent[] = [
    // alice — three rows inside May.
    makeEvent({ user: "alice", messageId: "a1", timestamp: MAY_1_UTC }),
    makeEvent({ user: "alice", messageId: "a2", timestamp: MAY_15_UTC }),
    makeEvent({ user: "alice", messageId: "a3", timestamp: JUN_1_UTC - 1 }),
    // bob — one row inside May, with bigger token totals.
    makeEvent({
      user: "bob",
      messageId: "b1",
      timestamp: MAY_15_UTC,
      inputTokens: 5000,
      outputTokens: 2500,
      cacheCreationTokens: 500,
      cacheReadTokens: 1000,
    }),
    // carol — two rows inside May.
    makeEvent({ user: "carol", messageId: "c1", timestamp: MAY_1_UTC + 1000 }),
    makeEvent({
      user: "carol",
      messageId: "c2",
      timestamp: MAY_15_UTC,
      inputTokens: 200,
      outputTokens: 100,
    }),
    // Boundary fixtures: one event at exactly JUN_1_UTC (must be EXCLUDED
    // from a May query under half-open semantics), one in April (must be
    // excluded as below the window).
    makeEvent({
      user: "alice",
      messageId: "boundary",
      timestamp: JUN_1_UTC,
      inputTokens: 99999,
      outputTokens: 99999,
    }),
    makeEvent({
      user: "alice",
      messageId: "before",
      timestamp: MAY_1_UTC - 1,
      inputTokens: 88888,
      outputTokens: 88888,
    }),
    // A user-message row should be excluded from token sums even if it
    // falls inside the window — token columns are zero but the row would
    // otherwise pollute `model` grouping if assistant-only filter slipped.
    makeEvent({
      user: "alice",
      messageId: "user-row",
      timestamp: MAY_15_UTC,
      model: "",
      messageType: "user",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }),
  ];
  open.store.insertMany(events);
  authed.store.insertMany(events);
});

afterAll(async () => {
  for (const fn of cleanups) await fn();
});

describe("api-v1: resolveRange()", () => {
  test("period=YYYY-MM resolves to UTC month half-open", () => {
    const r = resolveRange(new URLSearchParams("period=2026-05"));
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(MAY_1_UTC);
    expect(r.until).toBe(JUN_1_UTC);
  });

  test("period=YYYY-MM-DD resolves to UTC day half-open", () => {
    const r = resolveRange(new URLSearchParams("period=2026-05-15"));
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(MAY_15_UTC);
    expect(r.until).toBe(MAY_15_UTC + 24 * 60 * 60 * 1000);
  });

  test("period rejects month 13 and impossible dates", () => {
    expect("error" in resolveRange(new URLSearchParams("period=2026-13"))).toBe(true);
    expect("error" in resolveRange(new URLSearchParams("period=2026-02-30"))).toBe(true);
    expect("error" in resolveRange(new URLSearchParams("period=garbage"))).toBe(true);
  });

  test("since/until accepts unix-ms integers", () => {
    const r = resolveRange(new URLSearchParams(`since=${MAY_1_UTC}&until=${JUN_1_UTC}`));
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(MAY_1_UTC);
    expect(r.until).toBe(JUN_1_UTC);
  });

  test("since/until accepts ISO-8601 strings", () => {
    const r = resolveRange(
      new URLSearchParams("since=2026-05-01T00:00:00Z&until=2026-06-01T00:00:00Z"),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(MAY_1_UTC);
    expect(r.until).toBe(JUN_1_UTC);
  });

  test("since/until accepts plain YYYY-MM-DD (parsed as UTC midnight)", () => {
    const r = resolveRange(new URLSearchParams("since=2026-05-01&until=2026-06-01"));
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(MAY_1_UTC);
    expect(r.until).toBe(JUN_1_UTC);
  });

  test("rejects missing parameters", () => {
    expect("error" in resolveRange(new URLSearchParams(""))).toBe(true);
    expect("error" in resolveRange(new URLSearchParams("since=1"))).toBe(true);
  });

  test("rejects until <= since (half-open requires strict)", () => {
    const same = resolveRange(new URLSearchParams("since=1000&until=1000"));
    expect("error" in same).toBe(true);
    const back = resolveRange(new URLSearchParams("since=2000&until=1000"));
    expect("error" in back).toBe(true);
  });

  test("rejects malformed inputs", () => {
    expect("error" in resolveRange(new URLSearchParams("since=abc&until=1"))).toBe(true);
    expect("error" in resolveRange(new URLSearchParams("since=1&until=xyz"))).toBe(true);
    expect("error" in resolveRange(new URLSearchParams("since=-1&until=1"))).toBe(true);
  });

  test("TZ-less ISO datetimes are interpreted as UTC (never server-local)", () => {
    // Asserted against Date.UTC so any host-TZ leak fails this test.
    const r = resolveRange(
      new URLSearchParams("since=2026-06-01T00:00:00&until=2026-07-01T00:00:00"),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(Date.UTC(2026, 5, 1));
    expect(r.until).toBe(Date.UTC(2026, 6, 1));
  });

  test("explicit ±HH:MM offsets and short fractions parse exactly", () => {
    const r = resolveRange(
      new URLSearchParams({
        since: "2026-06-01T12:30:00+02:00",
        until: "2026-06-01T12:30:00.5Z",
      }),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.since).toBe(Date.UTC(2026, 5, 1, 10, 30));
    expect(r.until).toBe(Date.UTC(2026, 5, 1, 12, 30, 0, 500));
  });

  test("out-of-format date strings are rejected (no engine-specific parsing)", () => {
    const bad = [
      "June 1, 2026", // RFC-2822-ish
      "2026-06-01t00:00:00z", // lowercase t/z
      "2026-06-01T12:30:00+0200", // colon-less offset
    ];
    for (const s of bad) {
      const r = resolveRange(
        new URLSearchParams(`since=${encodeURIComponent(s)}&until=2026-07-01`),
      );
      expect("error" in r).toBe(true);
    }
  });
});

describe("api-v1: /api/v1/usage (open mode)", () => {
  test("returns documented shape for period=2026-05", async () => {
    const res = await openApp.request(new Request("http://x/api/v1/usage?period=2026-05"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);

    // Top-level shape: echo back the resolved window in both forms so a
    // caller can verify the period was interpreted correctly.
    expect(body.since).toBe(MAY_1_UTC);
    expect(body.until).toBe(JUN_1_UTC);
    expect(body.sinceIso).toBe("2026-05-01T00:00:00.000Z");
    expect(body.untilIso).toBe("2026-06-01T00:00:00.000Z");

    // Three seeded users, all in window. Boundary + pre-window rows on
    // alice are excluded, as is the user-message row.
    expect(body.users).toBeArray();
    expect(body.users.length).toBe(3);
    const byName = Object.fromEntries(body.users.map((u: any) => [u.user, u]));
    expect(byName.alice).toBeDefined();
    expect(byName.bob).toBeDefined();
    expect(byName.carol).toBeDefined();

    // Each user object has exactly the 5 advertised fields.
    for (const u of body.users) {
      const keys = Object.keys(u).sort();
      expect(keys).toEqual(["costUsd", "inputTokens", "outputTokens", "totalTokens", "user"]);
      expect(typeof u.inputTokens).toBe("number");
      expect(typeof u.outputTokens).toBe("number");
      expect(typeof u.totalTokens).toBe("number");
      expect(typeof u.costUsd).toBe("number");
      expect(u.totalTokens).toBe(u.inputTokens + u.outputTokens);
    }

    // bob has 5000 + 500 + 1000 = 6500 input, 2500 output.
    expect(byName.bob.inputTokens).toBe(6500);
    expect(byName.bob.outputTokens).toBe(2500);
    expect(byName.bob.totalTokens).toBe(9000);
    expect(byName.bob.costUsd).toBeGreaterThan(0);

    // alice has 3 assistant rows inside May (a1, a2, a3) each with
    // 1000+100+200 = 1300 input and 500 output → 3900/1500.
    expect(byName.alice.inputTokens).toBe(3900);
    expect(byName.alice.outputTokens).toBe(1500);

    // carol has 2 assistant rows: one default (1300/500) and one whose
    // override set only input/output (200/100) — cacheCreation/cacheRead
    // inherit the makeEvent defaults (100 + 200).
    expect(byName.carol.inputTokens).toBe(1300 + (200 + 100 + 200));
    expect(byName.carol.outputTokens).toBe(500 + 100);

    // Totals match sum of users to the cent.
    const sumIn = body.users.reduce((s: number, u: any) => s + u.inputTokens, 0);
    const sumOut = body.users.reduce((s: number, u: any) => s + u.outputTokens, 0);
    const sumCost = body.users.reduce((s: number, u: any) => s + u.costUsd, 0);
    expect(body.totals.inputTokens).toBe(sumIn);
    expect(body.totals.outputTokens).toBe(sumOut);
    expect(body.totals.totalTokens).toBe(sumIn + sumOut);
    // Cost is rounded once at totals level; allow 1e-3 USD slack for any
    // accumulated floating-point drift between per-user and total rounding.
    expect(Math.abs(body.totals.costUsd - sumCost)).toBeLessThan(0.001);
  });

  test("sorted by costUsd descending", async () => {
    const res = await openApp.request(new Request("http://x/api/v1/usage?period=2026-05"));
    const body = await jsonOf(res);
    for (let i = 1; i < body.users.length; i++) {
      expect(body.users[i - 1].costUsd).toBeGreaterThanOrEqual(body.users[i].costUsd);
    }
  });

  test("half-open: event at exactly `until` is EXCLUDED", async () => {
    // Range [MAY_15, JUN_1) excludes the boundary event at JUN_1 (alice's
    // 'boundary' row with 99999/99999). If totals don't go astronomical
    // we know the boundary row was excluded.
    const res = await openApp.request(
      new Request(`http://x/api/v1/usage?since=${MAY_15_UTC}&until=${JUN_1_UTC}`),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.totals.inputTokens).toBeLessThan(50_000);
    expect(body.totals.outputTokens).toBeLessThan(50_000);
  });

  test("half-open: event at exactly `since` is INCLUDED", async () => {
    // Range [MAY_1, MAY_1 + 1ms): only events at the exact MAY_1_UTC ms
    // are eligible. alice's 'a1' and carol's 'c1' are at MAY_1_UTC and
    // MAY_1_UTC + 1000 respectively, so only alice should appear.
    const res = await openApp.request(
      new Request(`http://x/api/v1/usage?since=${MAY_1_UTC}&until=${MAY_1_UTC + 1}`),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.users.length).toBe(1);
    expect(body.users[0].user).toBe("alice");
  });

  test("empty range returns users:[] and zero totals", async () => {
    const res = await openApp.request(new Request("http://x/api/v1/usage?since=1&until=2"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.users).toEqual([]);
    expect(body.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });

  test("user-message rows are excluded from token sums", async () => {
    // alice has a 'user-row' inside May with messageType='user'. If it
    // leaked into sums it would still contribute 0 tokens, but it would
    // also appear in our 3-user count. We verified the count above (3),
    // and alice's tokens match exactly the 3 assistant rows.
    const res = await openApp.request(new Request("http://x/api/v1/usage?period=2026-05"));
    const body = await jsonOf(res);
    const alice = body.users.find((u: any) => u.user === "alice");
    // 3 assistant rows × (1000+100+200) input = 3900.
    expect(alice.inputTokens).toBe(3900);
  });

  test("malformed period → 400", async () => {
    const res = await openApp.request(new Request("http://x/api/v1/usage?period=2026-99"));
    expect(res.status).toBe(400);
  });

  test("missing parameters → 400", async () => {
    const res = await openApp.request(new Request("http://x/api/v1/usage"));
    expect(res.status).toBe(400);
  });

  test("until <= since → 400", async () => {
    const res = await openApp.request(new Request("http://x/api/v1/usage?since=1000&until=1000"));
    expect(res.status).toBe(400);
  });
});

describe("api-v1: /api/v1/usage (authed mode)", () => {
  test("missing Authorization header → 401", async () => {
    const res = await authedApp.request(new Request("http://x/api/v1/usage?period=2026-05"));
    expect(res.status).toBe(401);
  });

  test("wrong bearer → 403", async () => {
    const res = await authedApp.request(
      new Request("http://x/api/v1/usage?period=2026-05", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("correct bearer → 200", async () => {
    const res = await authedApp.request(
      new Request("http://x/api/v1/usage?period=2026-05", {
        headers: { authorization: `Bearer ${API_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.users.length).toBe(3);
  });

  test("Bearer is case-insensitive on the scheme", async () => {
    const res = await authedApp.request(
      new Request("http://x/api/v1/usage?period=2026-05", {
        headers: { authorization: `bearer ${API_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});
