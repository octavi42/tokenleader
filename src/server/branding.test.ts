import { describe, expect, test } from "bun:test";
import {
  brandedTitle,
  defaultFaviconSvg,
  defaultLogoSvg,
  escapeHtml,
  injectBranding,
} from "./branding.ts";

describe("built-in brand defaults", () => {
  test("are embedded SVG strings (work without any files on disk)", () => {
    for (const svg of [defaultLogoSvg, defaultFaviconSvg]) {
      expect(typeof svg).toBe("string");
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    }
  });

  test("are theme-aware (dark/light safe via prefers-color-scheme)", () => {
    for (const svg of [defaultLogoSvg, defaultFaviconSvg]) {
      expect(svg).toContain("prefers-color-scheme: dark");
    }
  });
});

describe("escapeHtml", () => {
  test("escapes element and attribute metacharacters", () => {
    expect(escapeHtml(`<script>"a"&'b'</script>`)).toBe(
      "&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;",
    );
  });
});

describe("brandedTitle", () => {
  test("bare wordmark without a team name", () => {
    expect(brandedTitle()).toBe("tokenleader");
    expect(brandedTitle(undefined)).toBe("tokenleader");
  });

  test("appends the escaped team name", () => {
    expect(brandedTitle("acme")).toBe("tokenleader · acme");
    expect(brandedTitle("<acme>")).toBe("tokenleader · &lt;acme&gt;");
  });
});

describe("injectBranding (serve-time title/og rewrite)", () => {
  const SHELL = `<!doctype html><html><head>
<title>tokenleader</title>
<meta property="og:title" content="tokenleader" />
</head><body></body></html>`;

  test("no team name → HTML passes through untouched", () => {
    expect(injectBranding(SHELL)).toBe(SHELL);
    expect(injectBranding(SHELL, undefined)).toBe(SHELL);
  });

  test("rewrites <title> and og:title with the team name", () => {
    const out = injectBranding(SHELL, "acme");
    expect(out).toContain("<title>tokenleader · acme</title>");
    expect(out).toContain('<meta property="og:title" content="tokenleader · acme" />');
  });

  test("team name is operator input: <script> comes out escaped", () => {
    const out = injectBranding(SHELL, "<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("<title>tokenleader · &lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(out).toContain('content="tokenleader · &lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  test("quotes cannot break out of the og:title attribute", () => {
    const out = injectBranding(SHELL, `a" onload="x`);
    expect(out).toContain('content="tokenleader · a&quot; onload=&quot;x"');
  });

  test("$-sequences in a team name are not String.replace patterns", () => {
    const out = injectBranding(SHELL, "cost $& up $1");
    expect(out).toContain("<title>tokenleader · cost $&amp; up $1</title>");
  });

  test("placeholder-free HTML (custom shell) is left alone", () => {
    const custom = "<!doctype html><title>mine</title>";
    expect(injectBranding(custom, "acme")).toBe(custom);
  });
});
