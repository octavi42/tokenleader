import { afterEach, describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { makeTmpDir as mkTmpDir } from "../test-helpers";
import {
  deleteEndpointOverride,
  endpointOverridePath,
  isAcceptableEndpoint,
  normalizeEndpoint,
  readEndpointOverride,
  writeEndpointOverride,
} from "./endpoint-override";

let tmpCleanups: Array<() => Promise<void>> = [];

async function makeTmpDir(): Promise<string> {
  const { dir, cleanup } = await mkTmpDir("tokenleader-endpoint-");
  tmpCleanups.push(cleanup);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpCleanups.map((fn) => fn()));
  tmpCleanups = [];
});

describe("endpoint-override", () => {
  test("write/read roundtrip normalizes trailing slashes", async () => {
    const dir = await makeTmpDir();
    await writeEndpointOverride(dir, "https://new.example.com/");
    expect(await readEndpointOverride(dir)).toBe("https://new.example.com");
  });

  test("write is atomic: no *.tmp.* leftovers, file replaced in place", async () => {
    const dir = await makeTmpDir();
    await writeEndpointOverride(dir, "https://a.example.com");
    await writeEndpointOverride(dir, "https://b.example.com");
    expect(await readEndpointOverride(dir)).toBe("https://b.example.com");
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
    // Exactly the override file remains.
    expect(await fsp.readdir(dir)).toEqual(["endpoint"]);
  });

  test("write rejects malformed and non-localhost http endpoints", async () => {
    const dir = await makeTmpDir();
    await expect(writeEndpointOverride(dir, "not a url")).rejects.toThrow();
    await expect(writeEndpointOverride(dir, "http://evil.example.com")).rejects.toThrow();
    // Nothing was left behind by the failed writes.
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  test("read returns null when the file is absent", async () => {
    const dir = await makeTmpDir();
    expect(await readEndpointOverride(dir)).toBeNull();
  });

  test("read returns null for malformed or plain-http content", async () => {
    const dir = await makeTmpDir();
    await fsp.writeFile(endpointOverridePath(dir), "garbage not a url\n");
    expect(await readEndpointOverride(dir)).toBeNull();
    await fsp.writeFile(endpointOverridePath(dir), "http://evil.example.com\n");
    expect(await readEndpointOverride(dir)).toBeNull();
  });

  test("read accepts http://localhost for dev", async () => {
    const dir = await makeTmpDir();
    await fsp.writeFile(endpointOverridePath(dir), "http://localhost:8787\n");
    expect(await readEndpointOverride(dir)).toBe("http://localhost:8787");
  });

  test("delete removes the file; deleting a missing file is a no-op", async () => {
    const dir = await makeTmpDir();
    await writeEndpointOverride(dir, "https://x.example.com");
    await deleteEndpointOverride(dir);
    expect(await readEndpointOverride(dir)).toBeNull();
    await deleteEndpointOverride(dir); // no throw
  });

  test("isAcceptableEndpoint: https ok; http only for localhost; garbage no", () => {
    expect(isAcceptableEndpoint("https://lb.example.com")).toBe(true);
    expect(isAcceptableEndpoint("http://localhost")).toBe(true);
    expect(isAcceptableEndpoint("http://localhost:9999")).toBe(true);
    expect(isAcceptableEndpoint("http://evil.example.com")).toBe(false);
    expect(isAcceptableEndpoint("ftp://x.example.com")).toBe(false);
    expect(isAcceptableEndpoint("nonsense")).toBe(false);
    expect(isAcceptableEndpoint("")).toBe(false);
  });

  test("normalizeEndpoint trims whitespace and trailing slashes", () => {
    expect(normalizeEndpoint("  https://x.example.com//  ")).toBe("https://x.example.com");
    expect(normalizeEndpoint("https://x.example.com")).toBe("https://x.example.com");
  });
});
