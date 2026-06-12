import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexFile, type SessionTotals } from "./codex.ts";
import { listCodexFiles } from "./index.ts";

async function makeTempJsonl(name: string, lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-parser-test-"));
  const file = join(dir, name);
  await writeFile(file, lines.map((l) => l + "\n").join(""));
  return file;
}

function tokenCountEvent(
  ts: string,
  cum: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  },
  useTotal = false,
) {
  const usage = {
    input_tokens: cum.input,
    cached_input_tokens: cum.cached,
    output_tokens: cum.output,
    reasoning_output_tokens: cum.reasoning,
    total_tokens: cum.input + cum.output,
  };
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: useTotal ? { total_token_usage: usage } : { last_token_usage: usage },
    },
  };
}

const turnContextLine = (model: string) => ({
  timestamp: "2026-05-01T00:00:00.000Z",
  type: "turn_context",
  payload: { turn_id: "tc-1", model },
});

describe("parseCodexFile (synthetic)", () => {
  it("emits cumulative→delta events with model from turn_context", async () => {
    const path = await makeTempJsonl("rollout-A.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 100,
          output: 50,
          cached: 10,
          reasoning: 5,
        }),
      ),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", {
          input: 250,
          output: 130,
          cached: 30,
          reasoning: 12,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[0]!.source).toBe("codex");
    expect(r.events[0]!.model).toBe("gpt-5.5");
    expect(r.events[0]!.requestId).toBeNull();
    expect(r.events[0]!.cacheCreationTokens).toBe(0);
    // Codex `input_tokens` is INCLUSIVE of `cached_input_tokens`. The
    // parser subtracts cached at the delta boundary so downstream pricing
    // can apply a uniform formula across providers.
    //   Raw delta: input=100, cached=10 → non-cached = 90, cacheRead = 10.
    expect(r.events[0]!.inputTokens).toBe(90);
    expect(r.events[0]!.outputTokens).toBe(50);
    expect(r.events[0]!.cacheReadTokens).toBe(10);
    expect(r.events[0]!.reasoningTokens).toBe(5);
    // delta on second event: raw input delta=150, cached delta=20 → 130/20.
    expect(r.events[1]!.inputTokens).toBe(130);
    expect(r.events[1]!.outputTokens).toBe(80);
    expect(r.events[1]!.cacheReadTokens).toBe(20);
    expect(r.events[1]!.reasoningTokens).toBe(7);
    // sessionTotals still tracks CUMULATIVE raw counts (used for delta
    // bookkeeping across reads); they are not the emitted event values.
    expect(r.sessionTotals.inputTokens).toBe(250);
    expect(r.sessionTotals.outputTokens).toBe(130);
    expect(r.sessionTotals.cachedInputTokens).toBe(30);

    // sessionId derived from filename
    expect(r.events[0]!.sessionId).toBe("rollout-A");
    // messageIds unique within file
    const ids = new Set(r.events.map((e) => e.messageId));
    expect(ids.size).toBe(r.events.length);
  });

  it("preserves deltas across reads via prevSessionTotals", async () => {
    const path = await makeTempJsonl("rollout-B.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 100,
          output: 50,
          cached: 10,
          reasoning: 5,
        }),
      ),
    ]);
    const r1 = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r1.events.length).toBe(1);
    // input=100, cached=10 → non-cached = 90.
    expect(r1.events[0]!.inputTokens).toBe(90);
    expect(r1.events[0]!.cacheReadTokens).toBe(10);

    // Append a second event.
    const second =
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", {
          input: 250,
          output: 130,
          cached: 30,
          reasoning: 12,
        }),
      ) + "\n";
    const existing = await Bun.file(path).text();
    await writeFile(path, existing + second);

    const r2 = await parseCodexFile({
      path,
      byteOffset: r1.newOffset,
      user: "k",
      prevSessionTotals: r1.sessionTotals,
    });
    expect(r2.events.length).toBe(1);
    // raw input delta=150, cached delta=20 → non-cached = 130.
    expect(r2.events[0]!.inputTokens).toBe(130);
    expect(r2.events[0]!.cacheReadTokens).toBe(20);
    expect(r2.events[0]!.outputTokens).toBe(80);
  });

  it("falls back to total_token_usage when last_token_usage missing", async () => {
    const path = await makeTempJsonl("rollout-C.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent(
          "2026-05-01T00:00:01.000Z",
          {
            input: 10,
            output: 5,
            cached: 0,
            reasoning: 0,
          },
          true,
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.inputTokens).toBe(10);
  });

  it("handles cumulative reset (negative delta) by treating values as new baseline", async () => {
    const path = await makeTempJsonl("rollout-D.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 100,
          output: 50,
          cached: 0,
          reasoning: 0,
        }),
      ),
      // Server reports lower totals — simulates reset.
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", {
          input: 30,
          output: 15,
          cached: 0,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.inputTokens).toBe(30);
  });

  it("uses fallback model when no turn_context yet", async () => {
    const path = await makeTempJsonl("rollout-E.jsonl", [
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 10,
          output: 5,
          cached: 0,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events[0]!.model).toBe("gpt-5");
  });

  it("normalizes Codex cached-as-subset-of-input: input=10 cached=4 → input=6 cacheRead=4", async () => {
    // OpenAI's accounting reports `cached_input_tokens` as a subset of
    // `input_tokens`, not a disjoint bucket (ccusage confirms this in
    // apps/codex/src/token-utils.ts: `nonCached = input - cached`).
    // The parser MUST subtract at the boundary so downstream cost math
    // doesn't double-bill the cached portion (at both full-input and
    // cache-read rates).
    const path = await makeTempJsonl("rollout-cached-subset.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 10,
          output: 0,
          cached: 4,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.inputTokens).toBe(6);
    expect(r.events[0]!.cacheReadTokens).toBe(4);
    expect(r.events[0]!.cacheCreationTokens).toBe(0);
  });

  it("clamps cached at input when cached delta would exceed input delta", async () => {
    // Defensive: if a buggy/out-of-order log reports cached > input on a
    // delta, we clamp rather than emit negative inputTokens. The bucket
    // becomes cacheRead-only for that event.
    const path = await makeTempJsonl("rollout-cached-overflow.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 10,
          output: 5,
          cached: 20,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.inputTokens).toBe(0);
    expect(r.events[0]!.cacheReadTokens).toBe(10);
  });

  it("emits user-message events from response_item role=user with zero tokens", async () => {
    // Codex prepends a `response_item` line for the user's prompt. The parser
    // should emit a zero-token user event with messageType='user' and a
    // synthesized messageId that includes ':user:' so it can't collide
    // with the assistant-event id at the same timestamp.
    const path = await makeTempJsonl("rollout-user.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.500Z",
        type: "response_item",
        payload: { role: "user", content: "please optimize this loop" },
      }),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 100,
          output: 50,
          cached: 10,
          reasoning: 5,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);

    const userEv = r.events.find((e) => e.messageType === "user");
    const asstEv = r.events.find((e) => e.messageType === "assistant");
    expect(userEv).toBeDefined();
    expect(asstEv).toBeDefined();

    expect(userEv!.source).toBe("codex");
    expect(userEv!.inputTokens).toBe(0);
    expect(userEv!.outputTokens).toBe(0);
    expect(userEv!.cacheReadTokens).toBe(0);
    expect(userEv!.cacheCreationTokens).toBe(0);
    expect(userEv!.reasoningTokens).toBeNull();
    expect(userEv!.sessionId).toBe("rollout-user");
    expect(userEv!.messageId).toContain(":user:");
    // The assistant event preserves its full delta accounting.
    expect(asstEv!.inputTokens).toBe(90);
    expect(asstEv!.outputTokens).toBe(50);
    // IDs must be globally unique within the read.
    const ids = new Set(r.events.map((e) => e.messageId));
    expect(ids.size).toBe(r.events.length);
  });

  it("ignores response_item lines without role=user", async () => {
    // Defensive: the response_item path should be tight — assistant/tool
    // role values must not get tagged as user events.
    const path = await makeTempJsonl("rollout-asst-item.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.500Z",
        type: "response_item",
        payload: { role: "assistant", content: "ok" },
      }),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(0);
  });

  it("disambiguates same-timestamp events in messageId", async () => {
    const ts = "2026-05-01T00:00:01.000Z";
    const path = await makeTempJsonl("rollout-F.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(tokenCountEvent(ts, { input: 10, output: 5, cached: 0, reasoning: 0 })),
      JSON.stringify(tokenCountEvent(ts, { input: 20, output: 10, cached: 0, reasoning: 0 })),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    const ids = new Set(r.events.map((e) => e.messageId));
    expect(ids.size).toBe(r.events.length);
  });
});

describe("parseCodexFile (real local data)", () => {
  it("parses token_count events from a real session file", async () => {
    const all = await listCodexFiles();
    if (all.length === 0) {
      console.warn("no codex session files on this machine — skipping");
      return;
    }
    // Walk recent files until one yields events. ccusage docs confirm the
    // format; skip silently only if every candidate is empty.
    const recent = all
      .map((p) => ({ p, mt: Bun.file(p).lastModified }))
      .sort((a, b) => b.mt - a.mt)
      .slice(0, 80);

    let parsed: { path: string; events: number; sample: string } | null = null;
    let prev: SessionTotals | undefined;
    for (const { p } of recent) {
      const r = await parseCodexFile({
        path: p,
        byteOffset: 0,
        user: "k",
        prevSessionTotals: prev,
      });
      if (r.events.length > 0) {
        parsed = { path: p, events: r.events.length, sample: r.events[0]!.model };
        // sanity assertions on the first hit
        for (const ev of r.events) {
          expect(ev.source).toBe("codex");
          expect(ev.requestId).toBeNull();
          expect(ev.cacheCreationTokens).toBe(0);
          expect(typeof ev.sessionId).toBe("string");
          expect(ev.sessionId.length).toBeGreaterThan(0);
          expect(typeof ev.model).toBe("string");
          expect(ev.model.length).toBeGreaterThan(0);
          expect(typeof ev.timestamp).toBe("number");
          expect(Number.isFinite(ev.timestamp)).toBe(true);
        }
        const ids = new Set(r.events.map((e) => e.messageId));
        expect(ids.size).toBe(r.events.length);
        expect(r.newOffset).toBeGreaterThan(0);
        expect(r.sessionTotals.sessionId).toBe(r.events[0]!.sessionId);
        break;
      }
    }

    if (!parsed) {
      console.warn(
        `scanned ${recent.length} recent codex files; none had token_count events with usage`,
      );
      return;
    }
    console.log(
      `[codex real] file=${parsed.path} events=${parsed.events} firstModel=${parsed.sample}`,
    );
  });
});
