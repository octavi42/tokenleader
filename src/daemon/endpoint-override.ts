// Operator-driven endpoint migration: the server can repoint a fleet by
// sending an `X-Tokenleader-Canonical-Endpoint` header on /manifest.json
// responses. An accepted value is persisted at `<stateDir>/endpoint` and
// wins over TOKENLEADER_ENDPOINT at boot, so daemons follow the move without
// re-rendered plists. Written atomically (tmp + rename); the installer
// deletes it on reinstall — unlike the TOFU secret, the override is
// server-instance-specific.

import { promises as fsp } from "node:fs";
import path from "node:path";

const ENDPOINT_FILENAME = "endpoint";

export function endpointOverridePath(stateDir: string): string {
  return path.join(stateDir, ENDPOINT_FILENAME);
}

/** Trim whitespace + trailing slashes so equality checks are stable. */
export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Only `https://` URLs (or `http://localhost*` for dev) may repoint a
 * daemon. Anything else — malformed strings, plain-http hosts — is
 * rejected wherever an override enters the system (header AND file), so a
 * corrupted or attacker-written file can't downgrade transport security.
 */
export function isAcceptableEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && u.hostname === "localhost";
}

/**
 * Read `<stateDir>/endpoint`. Returns the normalized endpoint, or null when
 * the file is absent or its content is unacceptable (the caller falls back
 * to the env endpoint). Non-ENOENT I/O errors propagate.
 */
export async function readEndpointOverride(stateDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(endpointOverridePath(stateDir), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const endpoint = normalizeEndpoint(raw);
  return isAcceptableEndpoint(endpoint) ? endpoint : null;
}

/** Atomic write (tmp + rename). Throws on unacceptable endpoints. */
export async function writeEndpointOverride(stateDir: string, endpoint: string): Promise<void> {
  const value = normalizeEndpoint(endpoint);
  if (!isAcceptableEndpoint(value)) {
    throw new Error(`unacceptable endpoint override: ${endpoint}`);
  }
  await fsp.mkdir(stateDir, { recursive: true });
  const p = endpointOverridePath(stateDir);
  const tmp = `${p}.tmp.${process.pid}`;
  await fsp.writeFile(tmp, `${value}\n`, "utf8");
  await fsp.rename(tmp, p);
}

/** Remove the override; missing file is a no-op. */
export async function deleteEndpointOverride(stateDir: string): Promise<void> {
  try {
    await fsp.unlink(endpointOverridePath(stateDir));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw err;
  }
}
