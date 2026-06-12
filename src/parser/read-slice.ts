/**
 * Bounded, newline-aligned line reads for the JSONL session parsers.
 *
 * Both the Claude Code and Codex parsers used to do
 * `file.slice(byteOffset).text()`, materializing the entire unread remainder
 * of a session file as one string. A multi-GB session log (a runaway Codex
 * rollout, say) then exceeds the JS engine's max string length, which the
 * compiled daemon hits as a native abort (EXC_BREAKPOINT / SIGTRAP) that
 * bypasses the parsers' try/catch — so a single oversized file wedges the
 * daemon into a permanent crash loop and no usage ever gets posted.
 *
 * `readNewlineLines` reads the remainder in capped byte windows and yields one
 * decoded line at a time, never holding more than `MAX_READ_BYTES` of bytes
 * (plus one line) at once, while still consuming the whole file in a single
 * pass so the tick loop's mtime gating keeps working.
 */

/** ASCII line feed. A 0x0A byte never occurs inside a multi-byte UTF-8
 *  sequence (continuation/lead bytes are all >= 0x80), so scanning raw bytes
 *  for it splits lines without ever cutting a character. */
const NEWLINE = 0x0a;

const decoder = new TextDecoder();

/**
 * Largest byte window read at once — and therefore the largest single line we
 * can decode. Kept well under the ~512 MiB string-length ceiling where the
 * compiled daemon was observed to abort. A line longer than this can't be
 * materialized safely, so it is discarded (see below) rather than risking the
 * abort; multi-MB tool-result records stay comfortably within the window.
 */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

export interface LineRead {
  /**
   * One decoded JSONL line without its trailing newline, or `null` for an
   * offset-only advance (a skipped oversized line or blank bytes). Callers
   * ignore `null` lines but must still adopt `newOffset`.
   */
  line: string | null;
  /** Byte offset consumed through — always at a line boundary. */
  newOffset: number;
}

/**
 * Yield the lines of `file` starting at `byteOffset`, reading at most
 * `maxBytes` of raw bytes per window. The caller advances its saved offset to
 * the latest `newOffset` (including for `null` reads, so progress is never
 * lost).
 *
 * A trailing line with no terminator (a file still being written) is left
 * unconsumed for the next read. A single line longer than `maxBytes` can't be
 * held as one string, so it is discarded through its terminating newline — its
 * bytes are skipped a window at a time (guaranteeing forward progress) and its
 * eventual suffix is *not* emitted as a record.
 */
export async function* readNewlineLines(
  file: ReturnType<typeof Bun.file>,
  byteOffset: number,
  maxBytes: number = MAX_READ_BYTES,
): AsyncGenerator<LineRead> {
  if (!(maxBytes > 0)) {
    throw new RangeError(`maxBytes must be a positive number, got ${maxBytes}`);
  }

  const totalSize = file.size;
  let offset = byteOffset;
  // True while skipping the remainder of a line that overflowed the window —
  // its suffix must not be emitted as a standalone record.
  let discarding = false;

  while (offset < totalSize) {
    const end = Math.min(totalSize, offset + maxBytes);
    const bytes = await file.slice(offset, end).bytes();

    const lastNewline = bytes.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      // No line boundary in this window. At EOF it's an unterminated tail —
      // leave it (and do not commit an offset inside it) so the whole record
      // is re-read once it's complete. Otherwise a single line is longer than
      // the window: skip its bytes without committing and stay in discard mode
      // so its continuation isn't mistaken for a new line. The offset only
      // moves forward once that line's terminating newline is found below.
      if (end >= totalSize) return;
      discarding = true;
      offset = end;
      continue;
    }

    let start = 0;
    let nl = bytes.indexOf(NEWLINE);
    while (nl !== -1) {
      if (discarding) {
        // This newline closes the oversized line we were discarding.
        discarding = false;
      } else if (nl > start) {
        // Decode exactly one line's bytes — a clean range between newlines, so
        // it is always whole UTF-8.
        yield { line: decoder.decode(bytes.subarray(start, nl)), newOffset: offset + nl + 1 };
      }
      start = nl + 1;
      if (start > lastNewline) break;
      nl = bytes.indexOf(NEWLINE, start);
    }

    // Advance past the last complete line; any partial tail is re-read next
    // window. The marker syncs the offset even if the final lines were blank.
    offset += lastNewline + 1;
    yield { line: null, newOffset: offset };
  }
}
