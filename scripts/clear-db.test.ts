import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/server/db.ts";

const SCRIPT = resolve(import.meta.dir, "clear-db.sh");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(
  args: string[],
  dbPath: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TOKENLEADER_DB: dbPath,
      TOKENLEADER_CONFIRM: "yes",
      ...extraEnv,
    },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function seed(store: Store): void {
  store.insertMany([
    {
      user: "alice",
      source: "claude_code",
      sessionId: "s1",
      messageId: "m-alice-1",
      requestId: "r1",
      timestamp: 1_700_000_000_000,
      model: "claude-sonnet-4-5",
      messageType: "assistant",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    },
    {
      user: "alice",
      source: "claude_code",
      sessionId: "s1",
      messageId: "m-alice-2",
      requestId: "r2",
      timestamp: 1_700_000_000_001,
      model: "claude-sonnet-4-5",
      messageType: "assistant",
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    },
    {
      user: "bob",
      source: "claude_code",
      sessionId: "s2",
      messageId: "m-bob-1",
      requestId: "r3",
      timestamp: 1_700_000_000_002,
      model: "claude-sonnet-4-5",
      messageType: "assistant",
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    },
  ]);
  store.claimUserSecret("alice", "h-alice", Date.now());
  store.claimUserSecret("bob", "h-bob", Date.now());
}

describe("scripts/clear-db.sh", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clear-db-test-"));
    dbPath = join(tmpDir, "tl.sqlite");
    store = new Store(dbPath);
    seed(store);
    // Close so sqlite3 CLI can take the WAL lock cleanly.
    store.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("--help exits 0 and prints usage", () => {
    const r = runScript(["--help"], dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--all");
    expect(r.stdout).toContain("--user=NAME");
    expect(r.stdout).toContain("--reset-user=NAME");
    expect(r.stdout).toContain("--full");
  });

  test("no mode specified exits non-zero", () => {
    const r = runScript([], dbPath);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no mode specified");
  });

  test("--all wipes events but keeps user_secrets", () => {
    const r = runScript(["--all"], dbPath);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("done.");
    // Re-open and verify.
    const s = new Store(dbPath);
    expect(s.count()).toBe(0);
    expect(s.getUserSecretHash("alice")).not.toBeNull();
    expect(s.getUserSecretHash("bob")).not.toBeNull();
    s.close();
  });

  test("--user=alice wipes only alice's events", () => {
    const r = runScript(["--user=alice"], dbPath);
    expect(r.status).toBe(0);
    const s = new Store(dbPath);
    expect(s.count()).toBe(1); // bob's row survives
    // alice's secret still claimed (only events deleted, not user_secrets)
    expect(s.getUserSecretHash("alice")).not.toBeNull();
    s.close();
  });

  test("--user without a value exits non-zero", () => {
    const r = runScript(["--user="], dbPath);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--user requires a value");
  });

  test("rejects two mode flags at once", () => {
    const r = runScript(["--all", "--full"], dbPath);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("only one mode flag allowed");
  });

  test("--reset-user=alice wipes events + secret", () => {
    const r = runScript(["--reset-user=alice"], dbPath);
    expect(r.status).toBe(0);
    const s = new Store(dbPath);
    expect(s.count()).toBe(1); // bob still here
    expect(s.getUserSecretHash("alice")).toBeNull(); // claim removed
    expect(s.getUserSecretHash("bob")).not.toBeNull();
    s.close();
  });

  test("--full recreates both tables empty", () => {
    const r = runScript(["--full"], dbPath);
    expect(r.status).toBe(0);
    const s = new Store(dbPath);
    expect(s.count()).toBe(0);
    expect(s.getUserSecretHash("alice")).toBeNull();
    expect(s.getUserSecretHash("bob")).toBeNull();
    s.close();
  });

  test("missing DB file exits non-zero", () => {
    const r = runScript(["--all"], join(tmpDir, "does-not-exist.sqlite"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("DB not found");
  });

  test("prompts when neither --yes nor TOKENLEADER_CONFIRM=yes is set", () => {
    // Run with stdin piped 'no\n' and no env confirm.
    const r = spawnSync("bash", [SCRIPT, "--all"], {
      encoding: "utf8",
      input: "no\n",
      env: { ...process.env, TOKENLEADER_DB: dbPath, TOKENLEADER_CONFIRM: "" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("aborted");
    // Events still present.
    const s = new Store(dbPath);
    expect(s.count()).toBe(3);
    s.close();
  });
});
