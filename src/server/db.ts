import { Database, type Statement } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TokenEvent } from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  source TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  messageId TEXT NOT NULL,
  requestId TEXT,
  timestamp INTEGER NOT NULL,
  model TEXT NOT NULL,
  messageType TEXT NOT NULL DEFAULT 'assistant',
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  reasoningTokens INTEGER,
  -- Per-event cost in USD micros for sources that ship one (Cursor).
  -- NULL = derive via PricingCache (Claude Code + Codex); aggregations
  -- SUM(COALESCE(., 0)) so NULL is ignored.
  costUsdMicros INTEGER,
  ingestedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user_ts ON events (user, timestamp DESC);
CREATE INDEX IF NOT EXISTS events_user_model ON events (user, model);
-- For aggregations that filter on timestamp without a leading user
-- (otherwise a full table scan). The (timestamp, messageType) composite
-- lives in migrateMessageType — that column may not exist pre-migration.
CREATE INDEX IF NOT EXISTS events_ts        ON events (timestamp);
CREATE INDEX IF NOT EXISTS events_model_ts  ON events (model, timestamp);

CREATE TABLE IF NOT EXISTS user_secrets (
  username       TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL,
  claimed_at     INTEGER NOT NULL,
  uninstalled_at INTEGER,
  company        TEXT
);

-- Per-user daemon build last reported on /ingest (X-Tokenleader-Version /
-- X-Tokenleader-Arch headers); powers the dashboard fleet view.
CREATE TABLE IF NOT EXISTS daemon_status (
  username   TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  arch       TEXT,
  last_seen  INTEGER NOT NULL
);

-- Tiny KV for server state that must survive restarts
-- (e.g. cursor_watermark_ms, the CursorMirror backfill watermark).
CREATE TABLE IF NOT EXISTS server_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Migration: add `messageType` and key the dedup index by (user, source,
 * messageId, requestId, messageType). Idempotent. The dedup index is
 * rebuilt unconditionally — the old definition lacks messageType and would
 * collide user/assistant rows that share ids.
 */
function migrateMessageType(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(events)").all();
  const hasCol = cols.some((c) => c.name === "messageType");
  if (!hasCol) {
    // SQLite ALTER TABLE has no IF NOT EXISTS; gated by the PRAGMA check.
    // Default 'assistant' back-fills pre-migration rows correctly.
    db.exec("ALTER TABLE events ADD COLUMN messageType TEXT NOT NULL DEFAULT 'assistant'");
  }
  db.exec("DROP INDEX IF EXISTS events_dedup");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS events_dedup " +
      "ON events (user, source, messageId, COALESCE(requestId, ''), messageType)",
  );
  // Covers the assistant-only timestamp-range scans on every poll. Lives
  // here (not SCHEMA) because messageType may not exist until the ALTER.
  db.exec("CREATE INDEX IF NOT EXISTS events_ts_type ON events (timestamp, messageType)");
}

/**
 * Migration: add `uninstalled_at` to user_secrets. Idempotent. Non-NULL
 * means the user signaled /events/uninstall: shown as "Recently
 * uninstalled" and eligible for TOFU re-claim on the next /ingest.
 */
function migrateUninstalledAt(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(user_secrets)").all();
  const hasCol = cols.some((c) => c.name === "uninstalled_at");
  if (!hasCol) {
    db.exec("ALTER TABLE user_secrets ADD COLUMN uninstalled_at INTEGER");
  }
}

/**
 * Migration: add `company` to user_secrets. Idempotent. Nullable —
 * NULL means the user's daemon never sent X-Tokenleader-Company; an
 * absent header never clears a stored value.
 */
function migrateCompany(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(user_secrets)").all();
  const hasCol = cols.some((c) => c.name === "company");
  if (!hasCol) {
    db.exec("ALTER TABLE user_secrets ADD COLUMN company TEXT");
  }
}

/**
 * Migration: add `costUsdMicros` to events. Idempotent. Preserves
 * Cursor-provided cost verbatim; NULL falls back to PricingCache.
 */
function migrateCostUsdMicros(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(events)").all();
  if (!cols.some((c) => c.name === "costUsdMicros")) {
    db.exec("ALTER TABLE events ADD COLUMN costUsdMicros INTEGER");
  }
}

export interface ModelRow {
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  count: number;
  /**
   * SUM(costUsdMicros) for this model bucket. 0 → no stored cost, callers
   * price via PricingCache; non-zero → use the stored value and skip
   * PricingCache for this bucket.
   */
  storedCostMicros: number;
}

export interface UserTotalsRow {
  user: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalReasoningTokens: number;
}

export interface LeaderboardAdminRow extends UserTotalsRow {
  eventCount: number;
  lastEventAt: number;
  modelCount: number;
  userMessages: number;
  assistantMessages: number;
  /** Normalized company domain from user_secrets; null = never reported. */
  company: string | null;
}

/** Per-user message counts (assistant + user) — the user-row counts the
 *  token aggregates exclude. */
export interface UserMessageCountsRow {
  user: string;
  userMessages: number;
  assistantMessages: number;
}

export interface ModelAggRow {
  model: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  /** See ModelRow.storedCostMicros for semantics. */
  storedCostMicros: number;
}

export interface RecentEventRow {
  id: number;
  user: string;
  source: string;
  model: string;
  timestamp: number;
  totalTokens: number;
  messageType: string;
}

/** Per-(bucket, model) aggregate used by /stats/timeseries.
 *  Restricted to assistant rows so token totals stay meaningful. */
export interface TimeseriesModelRow {
  bucketKey: string; // strftime output, e.g. "2026-05-11" / "2026-W19" / "2026-05"
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  storedCostMicros: number;
}

/** Per-(bucket, user, model) aggregate for the byUser timeseries breakdown.
 *  Assistant rows only. */
export interface TimeseriesUserModelRow {
  bucketKey: string;
  user: string;
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  storedCostMicros: number;
}

/**
 * Per-bucket message-count aggregate (counts only, no tokens). Includes both
 * user and assistant rows so the dashboard can plot user-vs-assistant.
 */
export interface TimeseriesBucketCountsRow {
  bucketKey: string;
  userMessages: number;
  assistantMessages: number;
}

/** Per-(bucket, user) message-count aggregate. */
export interface TimeseriesUserCountsRow {
  bucketKey: string;
  user: string;
  userMessages: number;
  assistantMessages: number;
}

export type Bucket = "day" | "week" | "month";

export interface DbSizeRow {
  page_count: number;
  page_size: number;
}

export interface LastEventRow {
  ts: number | null;
}

export interface UserSecretRow {
  secret_hash: string;
  uninstalled_at: number | null;
}

export interface ClaimedUserRow {
  username: string;
  claimed_at: number;
}

export interface UninstalledUserRow {
  username: string;
  uninstalled_at: number;
}

export interface DaemonStatusRow {
  username: string;
  version: string;
  arch: string | null;
  last_seen: number;
}

/** Default exclusive upper bound for "lifetime" ranges. 2^53-1 ms ≈ year
 *  287,396 — effectively +infinity. */
export const MAX_TS_MS = Number.MAX_SAFE_INTEGER;

/** server_meta key for the CursorMirror backfill watermark (the only
 *  cursor-owned key); clearFull deletes it so cleared history re-imports. */
export const CURSOR_WATERMARK_META_KEY = "cursor_watermark_ms";

/** Company scope: restrict to events whose user is claimed under the given
 *  company (user_secrets.company, from X-Tokenleader-Company). A fixed
 *  string spliced into the *ForCompany statement variants — never user
 *  input, so this is splice-safe. */
const COMPANY_SCOPE = "AND user IN (SELECT username FROM user_secrets WHERE company = ?)";

/**
 * Per-(user, model) aggregate over `[since, until)` for `/api/v1`.
 * Assistant rows only — user-message rows have zero tokens and no model.
 */
export interface ApiUsageRow {
  user: string;
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  storedCostMicros: number;
}

/**
 * SQLite-backed event store.
 *
 * Range contract: all `(sinceMs, untilMs)` parameters are half-open
 * `[since, until)` unix-ms UTC — an event at `timestamp === since` is in,
 * an event at `timestamp === until` is out. `untilMs` defaults to MAX_TS_MS.
 */
export class Store {
  readonly db: Database;
  private readonly insertStmt: Statement;
  private readonly countStmt: Statement<{ c: number }>;
  private readonly userTotalsStmt: Statement<UserTotalsRow, [string, number, number]>;
  private readonly userByModelStmt: Statement<ModelRow, [string, number, number]>;
  private readonly leaderboardStmt: Statement<UserTotalsRow, [number, number]>;
  private readonly adminLeaderboardStmt: Statement<LeaderboardAdminRow, [number, number]>;
  private readonly adminLeaderboardForCompanyStmt: Statement<
    LeaderboardAdminRow,
    [number, number, string]
  >;
  private readonly adminByModelStmt: Statement<ModelAggRow, [number, number]>;
  private readonly adminByModelForCompanyStmt: Statement<ModelAggRow, [number, number, string]>;
  private readonly adminRecentStmt: Statement<RecentEventRow>;
  private readonly adminRecentForCompanyStmt: Statement<RecentEventRow, [string, number]>;
  private readonly listCompaniesStmt: Statement<{ company: string }, []>;
  private readonly dbSizeStmt: Statement<DbSizeRow>;
  private readonly lastEventStmt: Statement<LastEventRow>;
  private readonly getUserSecretStmt: Statement<UserSecretRow>;
  private readonly claimUserSecretStmt: Statement;
  private readonly listClaimedUsersStmt: Statement<ClaimedUserRow>;
  private readonly markUserUninstalledStmt: Statement;
  private readonly clearUninstalledAtStmt: Statement;
  private readonly updateUserSecretHashStmt: Statement;
  private readonly listUninstalledUsersStmt: Statement<UninstalledUserRow>;
  private readonly recordDaemonStatusStmt: Statement;
  private readonly listDaemonStatusStmt: Statement<DaemonStatusRow>;
  private readonly setUserCompanyStmt: Statement;
  private readonly getUserCompanyStmt: Statement<{ company: string | null }, [string]>;
  private readonly userMessageCountsAllStmt: Statement<UserMessageCountsRow, [number, number]>;
  private readonly userMessageCountsForUserStmt: Statement<
    UserMessageCountsRow,
    [string, number, number]
  >;
  // Timeseries: one prepared statement per (bucket × user-filter) shape.
  // The strftime() format string is spliced in from a fixed allow-list
  // (never user input), so this is splice-safe.
  private readonly tsByModelStmts: Record<Bucket, Statement<TimeseriesModelRow, [number, number]>>;
  private readonly tsByModelForUserStmts: Record<
    Bucket,
    Statement<TimeseriesModelRow, [string, number, number]>
  >;
  private readonly tsByModelForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesModelRow, [number, number, string]>
  >;
  private readonly tsByUserStmts: Record<
    Bucket,
    Statement<TimeseriesUserModelRow, [number, number]>
  >;
  private readonly tsByUserForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesUserModelRow, [number, number, string]>
  >;
  private readonly tsCountsByBucketStmts: Record<
    Bucket,
    Statement<TimeseriesBucketCountsRow, [number, number]>
  >;
  private readonly tsCountsByBucketForUserStmts: Record<
    Bucket,
    Statement<TimeseriesBucketCountsRow, [string, number, number]>
  >;
  private readonly tsCountsByBucketForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesBucketCountsRow, [number, number, string]>
  >;
  private readonly tsCountsByUserStmts: Record<
    Bucket,
    Statement<TimeseriesUserCountsRow, [number, number]>
  >;
  private readonly tsCountsByUserForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesUserCountsRow, [number, number, string]>
  >;
  private readonly apiUsageRangeStmt: Statement<ApiUsageRow, [number, number]>;
  private readonly getMetaStmt: Statement<{ value: string }, [string]>;
  private readonly setMetaStmt: Statement;

  constructor(path: string) {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new Database(abs, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    // cache_size is negative-KiB (~64 MB hot pages); mmap lets cold reads
    // skip the page-cache copy; temp_store=MEMORY keeps GROUP BY / ORDER BY
    // scratch out of temp files.
    this.db.exec("PRAGMA cache_size = -65536;");
    this.db.exec("PRAGMA mmap_size = 268435456;");
    this.db.exec("PRAGMA temp_store = MEMORY;");
    this.db.exec(SCHEMA);
    migrateMessageType(this.db);
    migrateUninstalledAt(this.db);
    migrateCompany(this.db);
    migrateCostUsdMicros(this.db);

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (user, source, sessionId, messageId, requestId, timestamp,
                           model, messageType, inputTokens, outputTokens, cacheCreationTokens,
                           cacheReadTokens, reasoningTokens, costUsdMicros, ingestedAt)
       VALUES ($user, $source, $sessionId, $messageId, $requestId, $timestamp,
               $model, $messageType, $inputTokens, $outputTokens, $cacheCreationTokens,
               $cacheReadTokens, $reasoningTokens, $costUsdMicros, $ingestedAt)
       ON CONFLICT DO NOTHING`,
    );
    this.countStmt = this.db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM events");
    // Token-aggregation queries restrict to messageType='assistant': user
    // rows carry zero tokens and no model, and would inflate event/model
    // counts. User-vs-assistant counts come from the message-count queries.
    this.userTotalsStmt = this.db.prepare<UserTotalsRow, [string, number, number]>(
      `SELECT user,
              COALESCE(SUM(inputTokens), 0)         AS totalInputTokens,
              COALESCE(SUM(outputTokens), 0)        AS totalOutputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS totalCacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS totalReasoningTokens
         FROM events
        WHERE user = ? AND timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY user`,
    );
    this.userByModelStmt = this.db.prepare<ModelRow, [string, number, number]>(
      `SELECT model,
              COALESCE(SUM(inputTokens), 0)         AS input,
              COALESCE(SUM(outputTokens), 0)        AS output,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreation,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheRead,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoning,
              COUNT(*)                              AS count,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
         FROM events
        WHERE user = ? AND timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY model
        ORDER BY (input + output + cacheCreation + cacheRead) DESC`,
    );
    this.leaderboardStmt = this.db.prepare<UserTotalsRow, [number, number]>(
      `SELECT user,
              COALESCE(SUM(inputTokens), 0)         AS totalInputTokens,
              COALESCE(SUM(outputTokens), 0)        AS totalOutputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS totalCacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS totalReasoningTokens
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY user
        ORDER BY (totalInputTokens + totalOutputTokens
                  + totalCacheCreationTokens + totalCacheReadTokens) DESC`,
    );
    // Token sums + counts restricted to assistant rows via CASE in one
    // scan; lastEventAt spans both kinds ("last seen" = any activity).
    // LEFT JOIN user_secrets (PK lookup per group) carries the company
    // affiliation; users without a claim row read company NULL.
    this.adminLeaderboardStmt = this.db.prepare<LeaderboardAdminRow, [number, number]>(
      `SELECT user,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN inputTokens         ELSE 0 END), 0) AS totalInputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN outputTokens        ELSE 0 END), 0) AS totalOutputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheCreationTokens ELSE 0 END), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheReadTokens     ELSE 0 END), 0) AS totalCacheReadTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN reasoningTokens     ELSE 0 END), 0) AS totalReasoningTokens,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END)                                AS eventCount,
              SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END)                                AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END)                                AS assistantMessages,
              COALESCE(MAX(timestamp), 0)                                                             AS lastEventAt,
              COUNT(DISTINCT CASE WHEN messageType='assistant' THEN model END)                        AS modelCount,
              us.company                                                                              AS company
         FROM events
         LEFT JOIN user_secrets us ON us.username = events.user
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY user
        ORDER BY (totalInputTokens + totalOutputTokens
                  + totalCacheCreationTokens + totalCacheReadTokens) DESC`,
    );
    // Company-scoped variant: same shape, restricted to users claimed under
    // the given company. (since, until, company) — the scope clause appends.
    this.adminLeaderboardForCompanyStmt = this.db.prepare<
      LeaderboardAdminRow,
      [number, number, string]
    >(
      `SELECT user,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN inputTokens         ELSE 0 END), 0) AS totalInputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN outputTokens        ELSE 0 END), 0) AS totalOutputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheCreationTokens ELSE 0 END), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheReadTokens     ELSE 0 END), 0) AS totalCacheReadTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN reasoningTokens     ELSE 0 END), 0) AS totalReasoningTokens,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END)                                AS eventCount,
              SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END)                                AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END)                                AS assistantMessages,
              COALESCE(MAX(timestamp), 0)                                                             AS lastEventAt,
              COUNT(DISTINCT CASE WHEN messageType='assistant' THEN model END)                        AS modelCount,
              us.company                                                                              AS company
         FROM events
         LEFT JOIN user_secrets us ON us.username = events.user
        WHERE timestamp >= ? AND timestamp < ? ${COMPANY_SCOPE}
        GROUP BY user
        ORDER BY (totalInputTokens + totalOutputTokens
                  + totalCacheCreationTokens + totalCacheReadTokens) DESC`,
    );
    this.adminByModelStmt = this.db.prepare<ModelAggRow, [number, number]>(
      `SELECT model,
              COUNT(*)                              AS count,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY model
        ORDER BY count DESC`,
    );
    this.adminByModelForCompanyStmt = this.db.prepare<ModelAggRow, [number, number, string]>(
      `SELECT model,
              COUNT(*)                              AS count,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant' ${COMPANY_SCOPE}
        GROUP BY model
        ORDER BY count DESC`,
    );
    // Message-count queries — both kinds; no token sums.
    this.userMessageCountsAllStmt = this.db.prepare<UserMessageCountsRow, [number, number]>(
      `SELECT user,
              SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
         FROM events
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY user`,
    );
    this.userMessageCountsForUserStmt = this.db.prepare<
      UserMessageCountsRow,
      [string, number, number]
    >(
      `SELECT user,
              SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
         FROM events
        WHERE user = ? AND timestamp >= ? AND timestamp < ?
        GROUP BY user`,
    );
    this.adminRecentStmt = this.db.prepare<RecentEventRow, [number]>(
      `SELECT id, user, source, model, timestamp, messageType,
              (inputTokens + outputTokens + cacheCreationTokens
                + cacheReadTokens + COALESCE(reasoningTokens, 0)) AS totalTokens
         FROM events
        ORDER BY id DESC
        LIMIT ?`,
    );
    // Company variant has no range predicate, so the scope clause opens the
    // WHERE itself (strip the leading "AND ").
    this.adminRecentForCompanyStmt = this.db.prepare<RecentEventRow, [string, number]>(
      `SELECT id, user, source, model, timestamp, messageType,
              (inputTokens + outputTokens + cacheCreationTokens
                + cacheReadTokens + COALESCE(reasoningTokens, 0)) AS totalTokens
         FROM events
        WHERE ${COMPANY_SCOPE.slice("AND ".length)}
        ORDER BY id DESC
        LIMIT ?`,
    );
    // The dashboard's company-filter pills: every distinct non-null company
    // across ALL users — deliberately never filtered by the company param.
    this.listCompaniesStmt = this.db.prepare<{ company: string }, []>(
      "SELECT DISTINCT company FROM user_secrets WHERE company IS NOT NULL ORDER BY company",
    );
    this.dbSizeStmt = this.db.prepare<DbSizeRow, []>(
      "SELECT (SELECT page_count FROM pragma_page_count) AS page_count, " +
        "(SELECT page_size FROM pragma_page_size) AS page_size",
    );
    this.lastEventStmt = this.db.prepare<LastEventRow, []>(
      "SELECT MAX(timestamp) AS ts FROM events",
    );
    this.getUserSecretStmt = this.db.prepare<UserSecretRow, [string]>(
      "SELECT secret_hash, uninstalled_at FROM user_secrets WHERE username = ?",
    );
    this.claimUserSecretStmt = this.db.prepare(
      `INSERT OR IGNORE INTO user_secrets (username, secret_hash, claimed_at)
       VALUES ($username, $secret_hash, $claimed_at)`,
    );
    this.listClaimedUsersStmt = this.db.prepare<ClaimedUserRow, []>(
      "SELECT username, claimed_at FROM user_secrets ORDER BY claimed_at ASC",
    );
    this.markUserUninstalledStmt = this.db.prepare(
      `UPDATE user_secrets SET uninstalled_at = $uninstalled_at
        WHERE username = $username`,
    );
    // /ingest re-claim path: rotate the stored hash + clear uninstalled_at
    // in a single update.
    this.updateUserSecretHashStmt = this.db.prepare(
      `UPDATE user_secrets
          SET secret_hash    = $secret_hash,
              claimed_at     = $claimed_at,
              uninstalled_at = NULL
        WHERE username = $username`,
    );
    this.clearUninstalledAtStmt = this.db.prepare(
      `UPDATE user_secrets SET uninstalled_at = NULL WHERE username = $username`,
    );
    this.listUninstalledUsersStmt = this.db.prepare<UninstalledUserRow, []>(
      `SELECT username, uninstalled_at FROM user_secrets
        WHERE uninstalled_at IS NOT NULL
        ORDER BY uninstalled_at DESC`,
    );
    this.recordDaemonStatusStmt = this.db.prepare(
      `INSERT INTO daemon_status (username, version, arch, last_seen)
       VALUES ($username, $version, $arch, $last_seen)
       ON CONFLICT(username) DO UPDATE SET
         version   = $version,
         arch      = $arch,
         last_seen = $last_seen`,
    );
    this.listDaemonStatusStmt = this.db.prepare<DaemonStatusRow, []>(
      `SELECT username, version, arch, last_seen FROM daemon_status
        ORDER BY username ASC`,
    );
    // UPDATE (not upsert): /ingest only calls this after a successful
    // claim/auth, so the user_secrets row always exists.
    this.setUserCompanyStmt = this.db.prepare(
      "UPDATE user_secrets SET company = $company WHERE username = $username",
    );
    this.getUserCompanyStmt = this.db.prepare<{ company: string | null }, [string]>(
      "SELECT company FROM user_secrets WHERE username = ?",
    );

    // strftime over 'unixepoch' is UTC — labels must not shift with the
    // server's local timezone. Weeks are ISO 8601 (%G-W%V, Monday start):
    // %W has a week-zero edge case and %U is Sunday-based.
    const bucketExpr: Record<Bucket, string> = {
      day: `strftime('%Y-%m-%d', timestamp/1000, 'unixepoch')`,
      week: `strftime('%G-W%V',   timestamp/1000, 'unixepoch')`,
      month: `strftime('%Y-%m',    timestamp/1000, 'unixepoch')`,
    };

    const mkByModel = (b: Bucket) =>
      this.db.prepare<TimeseriesModelRow, [number, number]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                model,
                COUNT(*)                              AS events,
                COALESCE(SUM(inputTokens), 0)         AS inputTokens,
                COALESCE(SUM(outputTokens), 0)        AS outputTokens,
                COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
                COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
                COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
                COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
           FROM events
          WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
          GROUP BY bucketKey, model
          ORDER BY bucketKey ASC, model ASC`,
      );
    const mkByModelForUser = (b: Bucket) =>
      this.db.prepare<TimeseriesModelRow, [string, number, number]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                model,
                COUNT(*)                              AS events,
                COALESCE(SUM(inputTokens), 0)         AS inputTokens,
                COALESCE(SUM(outputTokens), 0)        AS outputTokens,
                COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
                COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
                COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
                COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
           FROM events
          WHERE user = ? AND timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
          GROUP BY bucketKey, model
          ORDER BY bucketKey ASC, model ASC`,
      );
    const mkByModelForCompany = (b: Bucket) =>
      this.db.prepare<TimeseriesModelRow, [number, number, string]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                model,
                COUNT(*)                              AS events,
                COALESCE(SUM(inputTokens), 0)         AS inputTokens,
                COALESCE(SUM(outputTokens), 0)        AS outputTokens,
                COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
                COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
                COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
                COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
           FROM events
          WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant' ${COMPANY_SCOPE}
          GROUP BY bucketKey, model
          ORDER BY bucketKey ASC, model ASC`,
      );
    const mkByUser = (b: Bucket) =>
      this.db.prepare<TimeseriesUserModelRow, [number, number]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                user,
                model,
                COUNT(*)                              AS events,
                COALESCE(SUM(inputTokens), 0)         AS inputTokens,
                COALESCE(SUM(outputTokens), 0)        AS outputTokens,
                COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
                COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
                COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
                COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
           FROM events
          WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
          GROUP BY bucketKey, user, model
          ORDER BY bucketKey ASC, user ASC`,
      );
    const mkByUserForCompany = (b: Bucket) =>
      this.db.prepare<TimeseriesUserModelRow, [number, number, string]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                user,
                model,
                COUNT(*)                              AS events,
                COALESCE(SUM(inputTokens), 0)         AS inputTokens,
                COALESCE(SUM(outputTokens), 0)        AS outputTokens,
                COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
                COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
                COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
                COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
           FROM events
          WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant' ${COMPANY_SCOPE}
          GROUP BY bucketKey, user, model
          ORDER BY bucketKey ASC, user ASC`,
      );
    // Message-count timeseries (both kinds; no token sums).
    const mkCountsByBucket = (b: Bucket) =>
      this.db.prepare<TimeseriesBucketCountsRow, [number, number]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
                SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
           FROM events
          WHERE timestamp >= ? AND timestamp < ?
          GROUP BY bucketKey
          ORDER BY bucketKey ASC`,
      );
    const mkCountsByBucketForUser = (b: Bucket) =>
      this.db.prepare<TimeseriesBucketCountsRow, [string, number, number]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
                SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
           FROM events
          WHERE user = ? AND timestamp >= ? AND timestamp < ?
          GROUP BY bucketKey
          ORDER BY bucketKey ASC`,
      );
    const mkCountsByBucketForCompany = (b: Bucket) =>
      this.db.prepare<TimeseriesBucketCountsRow, [number, number, string]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
                SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
           FROM events
          WHERE timestamp >= ? AND timestamp < ? ${COMPANY_SCOPE}
          GROUP BY bucketKey
          ORDER BY bucketKey ASC`,
      );
    const mkCountsByUser = (b: Bucket) =>
      this.db.prepare<TimeseriesUserCountsRow, [number, number]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                user,
                SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
                SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
           FROM events
          WHERE timestamp >= ? AND timestamp < ?
          GROUP BY bucketKey, user
          ORDER BY bucketKey ASC, user ASC`,
      );
    const mkCountsByUserForCompany = (b: Bucket) =>
      this.db.prepare<TimeseriesUserCountsRow, [number, number, string]>(
        `SELECT ${bucketExpr[b]} AS bucketKey,
                user,
                SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
                SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
           FROM events
          WHERE timestamp >= ? AND timestamp < ? ${COMPANY_SCOPE}
          GROUP BY bucketKey, user
          ORDER BY bucketKey ASC, user ASC`,
      );

    this.tsByModelStmts = {
      day: mkByModel("day"),
      week: mkByModel("week"),
      month: mkByModel("month"),
    };
    this.tsByModelForUserStmts = {
      day: mkByModelForUser("day"),
      week: mkByModelForUser("week"),
      month: mkByModelForUser("month"),
    };
    this.tsByModelForCompanyStmts = {
      day: mkByModelForCompany("day"),
      week: mkByModelForCompany("week"),
      month: mkByModelForCompany("month"),
    };
    this.tsByUserStmts = {
      day: mkByUser("day"),
      week: mkByUser("week"),
      month: mkByUser("month"),
    };
    this.tsByUserForCompanyStmts = {
      day: mkByUserForCompany("day"),
      week: mkByUserForCompany("week"),
      month: mkByUserForCompany("month"),
    };
    this.tsCountsByBucketStmts = {
      day: mkCountsByBucket("day"),
      week: mkCountsByBucket("week"),
      month: mkCountsByBucket("month"),
    };
    this.tsCountsByBucketForUserStmts = {
      day: mkCountsByBucketForUser("day"),
      week: mkCountsByBucketForUser("week"),
      month: mkCountsByBucketForUser("month"),
    };
    this.tsCountsByBucketForCompanyStmts = {
      day: mkCountsByBucketForCompany("day"),
      week: mkCountsByBucketForCompany("week"),
      month: mkCountsByBucketForCompany("month"),
    };
    this.tsCountsByUserStmts = {
      day: mkCountsByUser("day"),
      week: mkCountsByUser("week"),
      month: mkCountsByUser("month"),
    };
    this.tsCountsByUserForCompanyStmts = {
      day: mkCountsByUserForCompany("day"),
      week: mkCountsByUserForCompany("week"),
      month: mkCountsByUserForCompany("month"),
    };

    // Per-(user, model) aggregate for /api/v1/usage; same half-open
    // contract as every other range query here.
    this.apiUsageRangeStmt = this.db.prepare<ApiUsageRow, [number, number]>(
      `SELECT user, model,
              COALESCE(SUM(inputTokens), 0)         AS input,
              COALESCE(SUM(outputTokens), 0)        AS output,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreation,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheRead,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoning,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY user, model`,
    );

    this.getMetaStmt = this.db.prepare<{ value: string }, [string]>(
      "SELECT value FROM server_meta WHERE key = ?",
    );
    this.setMetaStmt = this.db.prepare(
      `INSERT INTO server_meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = $value`,
    );

    // Prime the count cache once at open so /health never touches SQLite
    // (the field initializer ran to null before this body executed).
    this.cachedCount = this.countStmt.get()?.c ?? 0;
  }

  /**
   * Cached lifetime row count so count() does zero SQLite work on the
   * /health hot path. insertMany increments it; the clear paths null it
   * so the next count() re-derives from SQL.
   */
  private cachedCount: number | null = null;

  insertMany(events: TokenEvent[]): { inserted: number; duplicates: number } {
    const now = Date.now();
    let inserted = 0;
    const tx = this.db.transaction((batch: TokenEvent[]) => {
      for (const e of batch) {
        const res = this.insertStmt.run({
          $user: e.user,
          $source: e.source,
          $sessionId: e.sessionId,
          $messageId: e.messageId,
          $requestId: e.requestId,
          $timestamp: e.timestamp,
          $model: e.model,
          // Back-compat default for daemons predating the user/assistant
          // split; set explicitly so the statement needs no NULL placeholder.
          $messageType: e.messageType ?? "assistant",
          $inputTokens: e.inputTokens,
          $outputTokens: e.outputTokens,
          $cacheCreationTokens: e.cacheCreationTokens,
          $cacheReadTokens: e.cacheReadTokens,
          $reasoningTokens: e.reasoningTokens,
          $costUsdMicros: e.costUsdMicros ?? null,
          $ingestedAt: now,
        });
        if (res.changes > 0) inserted += 1;
      }
    });
    tx(events);
    if (this.cachedCount !== null) this.cachedCount += inserted;
    return { inserted, duplicates: events.length - inserted };
  }

  count(): number {
    if (this.cachedCount === null) {
      this.cachedCount = this.countStmt.get()?.c ?? 0;
    }
    return this.cachedCount;
  }

  userTotals(user: string, sinceMs: number, untilMs: number = MAX_TS_MS): UserTotalsRow | null {
    return this.userTotalsStmt.get(user, sinceMs, untilMs);
  }

  userByModel(user: string, sinceMs: number, untilMs: number = MAX_TS_MS): ModelRow[] {
    return this.userByModelStmt.all(user, sinceMs, untilMs);
  }

  leaderboard(sinceMs: number, untilMs: number = MAX_TS_MS): UserTotalsRow[] {
    return this.leaderboardStmt.all(sinceMs, untilMs);
  }

  adminLeaderboard(
    sinceMs: number = 0,
    untilMs: number = MAX_TS_MS,
    company?: string,
  ): LeaderboardAdminRow[] {
    if (company && company.length > 0) {
      return this.adminLeaderboardForCompanyStmt.all(sinceMs, untilMs, company);
    }
    return this.adminLeaderboardStmt.all(sinceMs, untilMs);
  }

  adminByModel(sinceMs: number = 0, untilMs: number = MAX_TS_MS, company?: string): ModelAggRow[] {
    if (company && company.length > 0) {
      return this.adminByModelForCompanyStmt.all(sinceMs, untilMs, company);
    }
    return this.adminByModelStmt.all(sinceMs, untilMs);
  }

  adminRecent(limit: number, company?: string): RecentEventRow[] {
    if (company && company.length > 0) {
      return this.adminRecentForCompanyStmt.all(company, limit);
    }
    return this.adminRecentStmt.all(limit);
  }

  /** Sorted distinct non-null companies across ALL users — the dashboard's
   *  filter pick-list, never narrowed by an active company filter. */
  listCompanies(): string[] {
    return this.listCompaniesStmt.all().map((r) => r.company);
  }

  /** Per-user (userMessages, assistantMessages) counts in the window.
   *  No token sums — see `adminLeaderboard` / `userTotals`. */
  userMessageCounts(sinceMs: number = 0, untilMs: number = MAX_TS_MS): UserMessageCountsRow[] {
    return this.userMessageCountsAllStmt.all(sinceMs, untilMs);
  }

  /** Single-user message counts; returns zeros (not null) when the user
   *  has no rows in the window. */
  userMessageCountsForUser(
    user: string,
    sinceMs: number = 0,
    untilMs: number = MAX_TS_MS,
  ): { userMessages: number; assistantMessages: number } {
    const row = this.userMessageCountsForUserStmt.get(user, sinceMs, untilMs);
    return {
      userMessages: row?.userMessages ?? 0,
      assistantMessages: row?.assistantMessages ?? 0,
    };
  }

  /** Per-bucket (userMessages, assistantMessages), optionally filtered to
   *  one user or one company (user wins when both are passed — it is the
   *  narrower scope). Composed with the token queries by /stats/timeseries. */
  timeseriesCountsByBucket(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    user?: string,
    company?: string,
  ): TimeseriesBucketCountsRow[] {
    if (user && user.length > 0) {
      return this.tsCountsByBucketForUserStmts[bucket].all(user, sinceMs, untilMs);
    }
    if (company && company.length > 0) {
      return this.tsCountsByBucketForCompanyStmts[bucket].all(sinceMs, untilMs, company);
    }
    return this.tsCountsByBucketStmts[bucket].all(sinceMs, untilMs);
  }

  timeseriesCountsByUser(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    company?: string,
  ): TimeseriesUserCountsRow[] {
    if (company && company.length > 0) {
      return this.tsCountsByUserForCompanyStmts[bucket].all(sinceMs, untilMs, company);
    }
    return this.tsCountsByUserStmts[bucket].all(sinceMs, untilMs);
  }

  timeseriesByModel(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    user?: string,
    company?: string,
  ): TimeseriesModelRow[] {
    if (user && user.length > 0) {
      return this.tsByModelForUserStmts[bucket].all(user, sinceMs, untilMs);
    }
    if (company && company.length > 0) {
      return this.tsByModelForCompanyStmts[bucket].all(sinceMs, untilMs, company);
    }
    return this.tsByModelStmts[bucket].all(sinceMs, untilMs);
  }

  timeseriesByUser(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    company?: string,
  ): TimeseriesUserModelRow[] {
    if (company && company.length > 0) {
      return this.tsByUserForCompanyStmts[bucket].all(sinceMs, untilMs, company);
    }
    return this.tsByUserStmts[bucket].all(sinceMs, untilMs);
  }

  /** Per-(user, model) token sums over `[since, until)`, assistant rows
   *  only. Callers price each pair and aggregate to per-user totals. */
  apiUsageRange(sinceMs: number, untilMs: number): ApiUsageRow[] {
    return this.apiUsageRangeStmt.all(sinceMs, untilMs);
  }

  /** Wipe the events table (keep user_secrets). Returns rows removed. */
  clearAllEvents(): number {
    const r = this.db.prepare("DELETE FROM events").run();
    this.cachedCount = null;
    return Number(r.changes);
  }

  /** Wipe events for one user. Returns rows removed. */
  clearUserEvents(user: string): number {
    const r = this.db.prepare("DELETE FROM events WHERE user = ?").run(user);
    this.cachedCount = null;
    return Number(r.changes);
  }

  /** Remove the TOFU claim for a user (so the next post claims fresh). */
  clearUserSecret(user: string): number {
    const r = this.db.prepare("DELETE FROM user_secrets WHERE username = ?").run(user);
    return Number(r.changes);
  }

  /** Forget a user's reported daemon build. Called wherever the claim is
   *  reset or reclaimed, so the fleet view never shows a stale build. */
  clearUserDaemonStatus(user: string): void {
    this.db.prepare("DELETE FROM daemon_status WHERE username = ?").run(user);
  }

  /** Nuclear: drop and recreate all tables. */
  clearFull(): void {
    this.cachedCount = null;
    this.db.exec(
      "DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS user_secrets; DROP TABLE IF EXISTS daemon_status;",
    );
    // server_meta survives (other keys may be unrelated state), but the
    // cursor watermark must go or cleared Cursor history never re-imports.
    this.deleteMeta(CURSOR_WATERMARK_META_KEY);
    this.db.exec(SCHEMA);
    // The dedup index is canonically defined in migrateMessageType.
    migrateMessageType(this.db);
    migrateUninstalledAt(this.db);
    migrateCompany(this.db);
  }

  dbSizeBytes(): number {
    const row = this.dbSizeStmt.get();
    if (!row) return 0;
    return row.page_count * row.page_size;
  }

  lastEventAt(): number | null {
    const row = this.lastEventStmt.get();
    return row?.ts ?? null;
  }

  getUserSecretHash(user: string): string | null {
    const row = this.getUserSecretStmt.get(user);
    return row?.secret_hash ?? null;
  }

  /** Full `user_secrets` row (secret hash + uninstall marker), camelCased. */
  getUserSecretRow(user: string): { secretHash: string; uninstalledAt: number | null } | null {
    const row = this.getUserSecretStmt.get(user);
    if (!row) return null;
    return {
      secretHash: row.secret_hash,
      uninstalledAt: row.uninstalled_at,
    };
  }

  claimUserSecret(user: string, secretHash: string, now: number): void {
    this.claimUserSecretStmt.run({
      $username: user,
      $secret_hash: secretHash,
      $claimed_at: now,
    });
  }

  /** Re-claim: rotate the stored secret hash and clear `uninstalled_at` in
   *  one UPDATE. Used by /ingest for previously-uninstalled users. */
  reclaimUserSecret(user: string, secretHash: string, now: number): void {
    this.updateUserSecretHashStmt.run({
      $username: user,
      $secret_hash: secretHash,
      $claimed_at: now,
    });
  }

  listClaimedUsers(): Array<{ user: string; claimedAt: number }> {
    return this.listClaimedUsersStmt
      .all()
      .map((r) => ({ user: r.username, claimedAt: r.claimed_at }));
  }

  /**
   * Mark a user uninstalled after a timing-safe secret compare (same scheme
   * as /ingest). Idempotent on repeat calls. Callers must pre-check
   * `getUserSecretRow` for the unknown-user case — the row must exist.
   */
  markUserUninstalled(
    user: string,
    secretHash: string,
    now: number,
  ): { matched: boolean; uninstalledAt: number | null } {
    const row = this.getUserSecretStmt.get(user);
    if (!row) return { matched: false, uninstalledAt: null };
    // Both sides are fixed 64-char hex digests; the length check is
    // defense-in-depth.
    const stored = Buffer.from(row.secret_hash, "hex");
    const presented = Buffer.from(secretHash, "hex");
    if (stored.length !== presented.length) {
      return { matched: false, uninstalledAt: null };
    }
    if (!timingSafeEqual(stored, presented)) {
      return { matched: false, uninstalledAt: null };
    }
    this.markUserUninstalledStmt.run({
      $username: user,
      $uninstalled_at: now,
    });
    return { matched: true, uninstalledAt: now };
  }

  /** Clear the uninstalled_at marker on a user (no-op if already null). */
  clearUserUninstalledAt(user: string): void {
    this.clearUninstalledAtStmt.run({ $username: user });
  }

  /** Users with `uninstalled_at` set, newest first. */
  listUninstalledUsers(): Array<{ user: string; uninstalledAt: number }> {
    return this.listUninstalledUsersStmt
      .all()
      .map((r) => ({ user: r.username, uninstalledAt: r.uninstalled_at }));
  }

  /**
   * Upsert the daemon build a user last reported on /ingest. Best-effort:
   * old daemons omit the headers, so their row stays absent → "unknown".
   */
  recordDaemonStatus(user: string, version: string, arch: string | null, now: number): void {
    this.recordDaemonStatusStmt.run({
      $username: user,
      $version: version,
      $arch: arch,
      $last_seen: now,
    });
  }

  /** Every user's last-reported daemon build, username-sorted. */
  listDaemonStatus(): DaemonStatusRow[] {
    return this.listDaemonStatusStmt.all();
  }

  /**
   * Upsert the normalized company a user's daemon reported via
   * X-Tokenleader-Company (last write wins). Only called with a valid
   * normalized domain — an absent or invalid header never clears the
   * stored value. No-op for unclaimed users.
   */
  setUserCompany(user: string, company: string): void {
    this.setUserCompanyStmt.run({ $username: user, $company: company });
  }

  /** A user's stored company affiliation; null = never reported. */
  getUserCompany(user: string): string | null {
    return this.getUserCompanyStmt.get(user)?.company ?? null;
  }

  /** Read a server_meta value. null when the key was never written. */
  getMeta(key: string): string | null {
    return this.getMetaStmt.get(key)?.value ?? null;
  }

  /** Upsert a server_meta value. */
  setMeta(key: string, value: string): void {
    this.setMetaStmt.run({ $key: key, $value: value });
  }

  /** Delete one server_meta key (no-op if absent). */
  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM server_meta WHERE key = ?").run(key);
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // best-effort: WAL + synchronous=NORMAL is crash-safe regardless
    }
    this.db.close();
  }
}
