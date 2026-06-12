import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const SECRET_FILENAME = "secret";

/**
 * Load the per-user TOFU secret from `<stateDir>/secret`, creating one on
 * first run. The secret is a 32-byte random value, hex-encoded, written
 * with mode 0o600. The same secret is reused on every restart and is what
 * the server uses to authenticate this username TOFU-style.
 */
export async function loadOrCreateSecret(stateDir: string): Promise<string> {
  await fs.mkdir(stateDir, { recursive: true });
  const p = path.join(stateDir, SECRET_FILENAME);
  try {
    const existing = (await fs.readFile(p, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
  }
  const generated = randomBytes(32).toString("hex");
  // O_EXCL-style write: try-rename via a tmp file so a partial write
  // is never visible. Mode 0o600 is enforced after the rename via chmod
  // (writeFile mode arg is honored at create time; chmod is belt+suspenders).
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, generated, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, p);
  await fs.chmod(p, 0o600);
  return generated;
}
