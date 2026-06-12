/**
 * Company-affiliation normalization for the X-Tokenleader-Company header
 * (daemon env TOKENLEADER_COMPANY, installer --company flag). The web UI
 * mirrors this client-side for the "Add a teammate" one-liner — keep the
 * two in lockstep.
 */

/** Lowercase bare hostname: dot-separated labels of [a-z0-9-], TLD ≥ 2
 *  alpha chars. No scheme, port, path, or leading "www.". */
const COMPANY_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Max company length AFTER normalization (matches the username cap). */
export const MAX_COMPANY_LENGTH = 64;

/**
 * Normalize a raw company value ("https://www.Anara.com/path",
 * "Anara.com", "anara.com") to a lowercase bare hostname: scheme, path,
 * query, fragment, and port stripped; leading "www." stripped. Returns
 * null for anything that doesn't normalize to a valid domain ≤ 64 chars —
 * callers ignore null (warn, never an error response).
 */
export function normalizeCompany(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  // Scheme ("https://", "http://", anything URL-shaped).
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Path / query / fragment.
  s = s.split(/[/?#]/, 1)[0] ?? "";
  // Port.
  s = s.replace(/:\d+$/, "");
  // Leading "www." (one strip — "www.www.x.com" keeps the inner one).
  s = s.replace(/^www\./, "");
  if (s.length === 0 || s.length > MAX_COMPANY_LENGTH) return null;
  if (!COMPANY_DOMAIN_RE.test(s)) return null;
  return s;
}
