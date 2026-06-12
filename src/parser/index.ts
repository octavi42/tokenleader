import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function resolveDir(envValue: string | undefined, fallback: string): string {
  const raw = envValue && envValue.length > 0 ? envValue : fallback;
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

export function getClaudeCodeProjectsDir(): string {
  // CLAUDE_CONFIG_DIR points at the .claude root; sessions live under projects/
  const root = resolveDir(process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude"));
  return join(root, "projects");
}

export function getCodexSessionsDir(): string {
  const root = resolveDir(process.env.CODEX_HOME, join(homedir(), ".codex"));
  return join(root, "sessions");
}

async function scanGlob(cwd: string, pattern: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
      out.push(join(cwd, rel));
    }
  } catch {
    // dir missing — return empty
  }
  return out;
}

export async function listClaudeCodeFiles(): Promise<string[]> {
  return scanGlob(getClaudeCodeProjectsDir(), "**/*.jsonl");
}

export async function listCodexFiles(): Promise<string[]> {
  return scanGlob(getCodexSessionsDir(), "**/*.jsonl");
}
