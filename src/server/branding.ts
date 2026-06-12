// Deployment branding: operators drop `logo.svg` / `favicon.svg` into
// `<data-dir>/brand/`; these Bun text imports are the built-in fallbacks,
// inlined under both `bun run` and `bun build --compile`.

import defaultFaviconSvg from "./brand-defaults/favicon.svg" with { type: "text" };
import defaultLogoSvg from "./brand-defaults/logo.svg" with { type: "text" };

export { defaultFaviconSvg, defaultLogoSvg };

/** Escape operator text for HTML element content and quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Page title for a deployment: `tokenleader · <team>` (escaped), or bare. */
export function brandedTitle(teamName?: string): string {
  return teamName ? `tokenleader · ${escapeHtml(teamName)}` : "tokenleader";
}

/**
 * Rewrite the neutral `tokenleader` <title>/og:title placeholders in the
 * built index.html to `tokenleader · <team>`. The team name is escaped, and
 * replacements use callback form so `$`-sequences in it can't act as
 * String.replace patterns.
 */
export function injectBranding(html: string, teamName?: string): string {
  if (!teamName) return html;
  const branded = brandedTitle(teamName);
  return html
    .replace(/<title>tokenleader<\/title>/, () => `<title>${branded}</title>`)
    .replace(
      /(<meta\s+property="og:title"\s+content=")tokenleader("\s*\/?>)/,
      (_m, pre: string, post: string) => `${pre}${branded}${post}`,
    );
}
