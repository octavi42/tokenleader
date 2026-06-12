/** Pure helpers for the install command builder. Kept React-free so the
 *  root test runner can import them without web/node_modules. */

/** Mirror of the installer's bash slugify: lowercase, runs of anything
 *  outside [a-z0-9_-] become "-", dashes collapse/trim, 32-char cap. Keeping
 *  the two in sync means the command we render claims exactly the handle
 *  the script would resolve. */
export function slugifyHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const COMPANY_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Client-side mirror of the server's normalization (src/server/company.ts):
 *  "https://www.Anara.com/path" → "anara.com". Lowercase bare hostname —
 *  scheme, path/query/hash, port and a leading "www." stripped — then
 *  validated (COMPANY_RE, ≤ 64 chars). Invalid → null, so the rendered
 *  one-liner simply omits --company instead of claiming a bad value. */
export function normalizeCompany(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/[/?#].*$/, ""); // path / query / hash
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/^www\./, "");
  if (s.length > 64 || !COMPANY_RE.test(s)) return null;
  return s;
}
