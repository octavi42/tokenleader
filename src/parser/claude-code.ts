import type { TokenEvent } from "../types.ts";

export interface ParseClaudeCodeOptions {
  path: string;
  byteOffset: number;
  user: string;
}

export interface ParseClaudeCodeResult {
  events: TokenEvent[];
  newOffset: number;
  seenDedupKeys: string[];
}

interface RawCCRecord {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  sessionId?: string;
  requestId?: string | null;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Tail-read a Claude Code session jsonl file from `byteOffset`.
 *
 * Returns parsed events plus a new byte offset that points at the start of
 * any partial trailing line, so the next tick re-reads it fully. Emits one
 * event per assistant line with a `message.usage` block (token-bearing), and
 * one zero-token messageType='user' event per HUMAN prompt line.
 *
 * User lines carry no `message.id` (only API responses do), so they are
 * keyed on the line `uuid`. Tool results, meta lines, and sidechain
 * (subagent) prompts also arrive as type='user' — excluded, or "user
 * messages" would mostly count tool outputs.
 */
export async function parseClaudeCodeFile(
  opts: ParseClaudeCodeOptions,
): Promise<ParseClaudeCodeResult> {
  const { path, byteOffset, user } = opts;

  const file = Bun.file(path);
  const totalSize = file.size;
  if (byteOffset >= totalSize) {
    return { events: [], newOffset: totalSize, seenDedupKeys: [] };
  }

  const slice = file.slice(byteOffset);
  const text = await slice.text();

  // Find offset of the last newline within `text`. Anything after it is a
  // partial line we shouldn't consume yet.
  const lastNewline = text.lastIndexOf("\n");
  const consumeUpTo = lastNewline === -1 ? 0 : lastNewline + 1;
  const consumable = text.slice(0, consumeUpTo);
  // Bun.file slices are byte-accurate; .text() gives UTF-8 decoded string.
  // Compute byte length of consumed prefix to advance offset correctly.
  const consumedBytes = Buffer.byteLength(consumable, "utf8");
  const newOffset = byteOffset + consumedBytes;

  const events: TokenEvent[] = [];
  const seenDedupKeys: string[] = [];
  const localSeen = new Set<string>();

  if (consumable.length === 0) {
    return { events, newOffset, seenDedupKeys };
  }

  const lines = consumable.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    let raw: RawCCRecord;
    try {
      raw = JSON.parse(line) as RawCCRecord;
    } catch {
      continue;
    }
    if (raw.type !== "assistant" && raw.type !== "user") continue;
    const msg = raw.message;
    if (!msg) continue;

    const requestId = isString(raw.requestId) ? raw.requestId : null;
    const tsMs = isString(raw.timestamp) ? Date.parse(raw.timestamp) : NaN;
    const timestamp = Number.isFinite(tsMs) ? tsMs : Date.now();
    const sessionId = isString(raw.sessionId) ? raw.sessionId : "";

    if (raw.type === "user") {
      // Human prompts only: user lines have no message.id, so key on the
      // line uuid; skip tool results, meta lines, and subagent prompts.
      if (!isString(raw.uuid)) continue;
      if (raw.isMeta === true || raw.isSidechain === true) continue;
      const content = msg.content;
      if (
        Array.isArray(content) &&
        content.some(
          (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result",
        )
      ) {
        continue;
      }
      const dedupKey = `${raw.uuid}:`;
      if (localSeen.has(dedupKey)) continue;
      localSeen.add(dedupKey);
      events.push({
        user,
        source: "claude_code",
        sessionId,
        messageId: raw.uuid,
        requestId: null,
        timestamp,
        model: "",
        messageType: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: null,
      });
      seenDedupKeys.push(dedupKey);
      continue;
    }

    // Assistant path — must have a usage block and an API message id.
    if (!isString(msg.id)) continue;
    const dedupKey = `${msg.id}:${requestId ?? ""}`;
    if (localSeen.has(dedupKey)) continue;
    if (!msg.usage) continue;
    localSeen.add(dedupKey);

    const usage = msg.usage;
    const inputTokens = isNum(usage.input_tokens) ? usage.input_tokens : 0;
    const outputTokens = isNum(usage.output_tokens) ? usage.output_tokens : 0;
    const cacheCreation = isNum(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0;
    const cacheRead = isNum(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;

    // Skip lines that report zero usage in every bucket — they're noise
    // (status pings or the like) and only inflate event counts.
    if (inputTokens === 0 && outputTokens === 0 && cacheCreation === 0 && cacheRead === 0) {
      continue;
    }

    events.push({
      user,
      source: "claude_code",
      sessionId,
      messageId: msg.id,
      requestId,
      timestamp,
      model: isString(msg.model) ? msg.model : "",
      messageType: "assistant",
      inputTokens,
      outputTokens,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
      reasoningTokens: null,
    });
    seenDedupKeys.push(dedupKey);
  }

  return { events, newOffset, seenDedupKeys };
}
