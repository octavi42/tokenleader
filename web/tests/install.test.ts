import { describe, expect, it } from "bun:test";
import { normalizeCompany, slugifyHandle } from "../src/handle";

// Parity contract with the installer's bash slugify (install-script.ts):
// lowercase → non-[a-z0-9_-] runs become "-" → collapse → trim → 32 chars.
describe("slugifyHandle", () => {
  it("matches the installer's slug rules", () => {
    expect(slugifyHandle("naveed")).toBe("naveed");
    expect(slugifyHandle("Krish N!")).toBe("krish-n");
    expect(slugifyHandle("  Wing  ")).toBe("wing");
    expect(slugifyHandle("a_b-c")).toBe("a_b-c");
    expect(slugifyHandle("--weird--")).toBe("weird");
    expect(slugifyHandle("Ümläut çafé")).toBe("ml-ut-af");
    expect(slugifyHandle("x".repeat(40))).toBe("x".repeat(32));
    expect(slugifyHandle("!!!")).toBe("");
  });
});

// Parity contract with the server's company normalization
// (src/server/company.ts): lowercase bare hostname, scheme/path/port
// stripped, leading "www." stripped, ≤ 64 chars, domain-shaped or null.
describe("normalizeCompany", () => {
  it("normalizes URLs and mixed case down to the bare domain", () => {
    expect(normalizeCompany("https://www.Anara.com/path")).toBe("anara.com");
    expect(normalizeCompany("Anara.com")).toBe("anara.com");
    expect(normalizeCompany("anara.com")).toBe("anara.com");
    expect(normalizeCompany("http://anara.com:8080/x?q=1#frag")).toBe("anara.com");
    expect(normalizeCompany("www.anara.com")).toBe("anara.com");
    expect(normalizeCompany("  anara.com  ")).toBe("anara.com");
  });

  it("keeps multi-label domains intact", () => {
    expect(normalizeCompany("sub.domain.co.uk")).toBe("sub.domain.co.uk");
    expect(normalizeCompany("https://teams.linear.app")).toBe("teams.linear.app");
  });

  it("rejects non-domains with null", () => {
    expect(normalizeCompany("")).toBeNull();
    expect(normalizeCompany("   ")).toBeNull();
    expect(normalizeCompany("not a domain")).toBeNull();
    expect(normalizeCompany("anara")).toBeNull(); // no TLD
    expect(normalizeCompany("anara.c")).toBeNull(); // 1-char TLD
    expect(normalizeCompany("anara.com4")).toBeNull(); // digit in TLD
    expect(normalizeCompany("user@anara.com")).toBeNull(); // userinfo
  });

  it("caps at 64 chars after normalization", () => {
    expect(normalizeCompany(`${"a".repeat(60)}.com`)).toBe(`${"a".repeat(60)}.com`); // 64 ok
    expect(normalizeCompany(`${"a".repeat(61)}.com`)).toBeNull(); // 65 too long
  });
});
