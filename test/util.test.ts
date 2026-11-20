import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertValidCycleId,
  errorMessage,
  formatUsdc,
  readOption,
  readPositionalArg,
  trimToUndefined,
  writeFileAtomic,
} from "../src/util.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-util-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("errorMessage", () => {
  it("returns an Error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("trimToUndefined", () => {
  it("trims values and treats blank ones as absent", () => {
    expect(trimToUndefined("  key ")).toBe("key");
    expect(trimToUndefined("   ")).toBeUndefined();
    expect(trimToUndefined("")).toBeUndefined();
    expect(trimToUndefined(undefined)).toBeUndefined();
  });
});

describe("readOption", () => {
  it("reads --flag value and --flag=value forms", () => {
    expect(readOption(["--cycle", "c1"], "--cycle")).toBe("c1");
    expect(readOption(["--cycle=c2"], "--cycle")).toBe("c2");
    expect(readOption(["--other", "x"], "--cycle")).toBeUndefined();
  });
});

describe("readPositionalArg", () => {
  it("returns the first bare argument", () => {
    expect(readPositionalArg(["draft-1"], [])).toBe("draft-1");
    expect(readPositionalArg(["--json", "draft-1"], [])).toBe("draft-1");
  });

  it("skips the value of a preceding value-taking flag", () => {
    expect(readPositionalArg(["--cycle", "c1", "draft-1"], ["--cycle"])).toBe(
      "draft-1",
    );
    expect(
      readPositionalArg(["--note", "looks good", "draft-1"], ["--note"]),
    ).toBe("draft-1");
  });

  it("skips --flag=value forms and honors a bare -- separator", () => {
    expect(readPositionalArg(["--cycle=c1", "draft-1"], ["--cycle"])).toBe(
      "draft-1",
    );
    expect(readPositionalArg(["--", "--cycle"], ["--cycle"])).toBe("--cycle");
  });

  it("returns undefined when no positional is present", () => {
    expect(readPositionalArg(["--cycle", "c1"], ["--cycle"])).toBeUndefined();
    expect(readPositionalArg(["--json"], [])).toBeUndefined();
    expect(readPositionalArg([], [])).toBeUndefined();
  });
});

describe("writeFileAtomic", () => {
  it("writes the content and leaves no temp file behind", async () => {
    const dir = await makeTempDir();
    const target = join(dir, "record.json");

    await writeFileAtomic(target, '{"a":1}\n');

    expect(await readFile(target, "utf-8")).toBe('{"a":1}\n');
    expect(await readdir(dir)).toEqual(["record.json"]);
  });
});

describe("formatUsdc", () => {
  it("rounds to cents instead of printing float artefacts", () => {
    expect(formatUsdc(0.1 + 0.2)).toBe("0.3 USDC");
    expect(formatUsdc(4.87)).toBe("4.87 USDC");
    expect(formatUsdc(0)).toBe("0 USDC");
  });
});

describe("assertValidCycleId", () => {
  it("accepts ordinary ids, including the default timestamp shape", () => {
    expect(() =>
      assertValidCycleId("cycle-2026-11-20T10:00:00.000Z"),
    ).not.toThrow();
    expect(() => assertValidCycleId("cycle-1")).not.toThrow();
    expect(() => assertValidCycleId("manual-2026-11-20T16:00:00.000Z")).not.toThrow();
  });

  it("rejects path traversal and empty ids", () => {
    for (const bad of ["../../x", "..", ".", "", "a/b", "a\\b", "a..b"]) {
      expect(() => assertValidCycleId(bad)).toThrow(/cycle id/i);
    }
  });
});
