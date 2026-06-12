/**
 * Admin bearer handling for the /admin panel. sessionStorage ONLY — the
 * token dies with the tab. On module load we also delete the localStorage
 * copies older deployments persisted (localStorage outlives the session).
 */

const ADMIN_TOKEN_KEY = "tokenleaderAdminToken";
const LEGACY_KEYS = ["tokenleaderAdminToken", "tokenleaderToken"] as const;

export function purgeLegacyTokenStorage(): void {
  try {
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // storage unavailable — nothing to purge
  }
}

export function loadAdminToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeAdminToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // best-effort
  }
}
