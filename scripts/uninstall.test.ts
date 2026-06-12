import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercises the plist-extraction logic in scripts/uninstall.sh without
// running the destructive bootout/rm tail: fixture plist + secret under a
// temp HOME, driven through the awk-only fallback (the path taken when
// /usr/libexec/PlistBuddy is missing — the only surface portable to CI).

const SCRIPT = resolve(import.meta.dir, "uninstall.sh");

const FIXTURE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.anara.leaderboard</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENLEADER_USER</key>
        <string>krish-fixture</string>
        <key>TOKENLEADER_ENDPOINT</key>
        <string>https://leaderboard.example.com</string>
    </dict>
</dict>
</plist>
`;

describe("scripts/uninstall.sh", () => {
  let tmpHome: string;
  let plistPath: string;
  let secretPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "tokenleader-uninst-script-"));
    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(tmpHome, ".local", "share", "anara-leaderboard"), { recursive: true });
    plistPath = join(tmpHome, "Library", "LaunchAgents", "sh.anara.leaderboard.plist");
    secretPath = join(tmpHome, ".local", "share", "anara-leaderboard", "secret");
    writeFileSync(plistPath, FIXTURE_PLIST);
    writeFileSync(secretPath, "fixture-secret-deadbeef\n");
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("awk fallback extracts TOKENLEADER_USER from the plist", () => {
    // Mirrors the exact awk one-liner used inside notify_server_uninstall().
    // If this regex ever drifts, the script silently falls back to "no
    // handle" and the dashboard never sees the uninstall event.
    const r = spawnSync(
      "awk",
      [
        '/<key>TOKENLEADER_USER<\\/key>/{getline; gsub(/.*<string>|<\\/string>.*/, ""); print; exit}',
        plistPath,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("krish-fixture");
  });

  test("script is valid bash syntax", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
