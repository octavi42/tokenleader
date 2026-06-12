import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Store } from "./db.ts";
import { type PricingCache, computeRowCostUsd, roundUsd } from "./pricing.ts";
import { resolveRange } from "./range.ts";

/**
 * External v1 API: stable, narrow surface for bots/scripts, independent of
 * the dashboard's `/stats/*`. Ranges are half-open `[since, until)` unix-ms
 * UTC (parsing shared via range.ts); sums cover assistant messages only.
 * Auth: open when TOKENLEADER_API_TOKEN is unset, else a timing-safe
 * `Authorization: Bearer` match.
 */

// Re-exported for back-compat with existing imports.
export { resolveRange } from "./range.ts";

export interface ApiV1Deps {
  store: Store;
  pricing: PricingCache;
  /** Optional bearer token. Unset → route is open. */
  apiToken?: string;
}

/**
 * Per-user shape for `/api/v1/usage`. inputTokens folds in both cache
 * buckets (everything the model read); outputTokens already contains
 * reasoning (adding it would double-count Codex). Models missing from the
 * pricing table contribute zero cost, matching the dashboard.
 */
export interface ApiUsageUserOut {
  user: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ApiUsageOut {
  since: number;
  until: number;
  sinceIso: string;
  untilIso: string;
  users: ApiUsageUserOut[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

export function computeApiUsage(deps: ApiV1Deps, since: number, until: number): ApiUsageOut {
  const rows = deps.store.apiUsageRange(since, until);

  // Accumulate cost in float USD and round once at the end; per-(user,
  // model) rounding would visibly drift on big monthly totals.
  const perUser = new Map<string, { input: number; output: number; cost: number }>();
  for (const r of rows) {
    let acc = perUser.get(r.user);
    if (!acc) {
      acc = { input: 0, output: 0, cost: 0 };
      perUser.set(r.user, acc);
    }
    acc.input += r.input + r.cacheCreation + r.cacheRead;
    acc.output += r.output;
    // Source-provided cost (Cursor) wins over PricingCache derivation —
    // identical to /stats/admin, so API and dashboard reconcile exactly.
    if (r.storedCostMicros > 0) {
      acc.cost += r.storedCostMicros / 1_000_000;
    } else {
      const price = deps.pricing.lookup(r.model);
      if (price) {
        acc.cost += computeRowCostUsd(
          {
            input: r.input,
            output: r.output,
            cacheCreation: r.cacheCreation,
            cacheRead: r.cacheRead,
            reasoning: r.reasoning,
          },
          price,
        );
      }
    }
  }

  const users: ApiUsageUserOut[] = Array.from(perUser.entries())
    .map(([user, v]) => ({
      user,
      inputTokens: v.input,
      outputTokens: v.output,
      totalTokens: v.input + v.output,
      costUsd: roundUsd(v.cost),
    }))
    // Cost desc (dashboard ranking); user asc tiebreak for stable order.
    .sort((a, b) => {
      if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
      return a.user.localeCompare(b.user);
    });

  // Re-sum from the unrounded floats so totals.costUsd matches sum(users)
  // bit-exactly after a single rounding pass.
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  for (const v of perUser.values()) {
    totalCost += v.cost;
    totalInput += v.input;
    totalOutput += v.output;
  }

  return {
    since,
    until,
    sinceIso: new Date(since).toISOString(),
    untilIso: new Date(until).toISOString(),
    users,
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      costUsd: roundUsd(totalCost),
    },
  };
}

function checkAuth(
  apiToken: string | undefined,
  authHeader: string | undefined,
): { ok: true } | { ok: false; status: 401 | 403; error: string } {
  if (!apiToken || apiToken.length === 0) return { ok: true };
  const presented = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (presented.length === 0) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const a = Buffer.from(apiToken);
  const b = Buffer.from(presented);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 403, error: "invalid bearer token" };
  }
  return { ok: true };
}

export function mountApiV1(app: Hono, deps: ApiV1Deps): void {
  app.get("/api/v1/usage", (c) => {
    const auth = checkAuth(
      deps.apiToken,
      c.req.header("authorization") ?? c.req.header("Authorization"),
    );
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const url = new URL(c.req.url);
    const range = resolveRange(url.searchParams);
    if ("error" in range) return c.json({ error: range.error }, 400);

    const out = computeApiUsage(deps, range.since, range.until);
    return c.json(out);
  });
}
