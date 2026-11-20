import { describe, expect, it } from "vitest";

import { runCli, type CliOutput } from "../src/cli.js";

function captureOutput(): { chunks: { err: string; out: string }; output: CliOutput } {
  const chunks = { err: "", out: "" };
  const output: CliOutput = {
    writeErr(text: string) {
      chunks.err += text;
    },
    writeOut(text: string) {
      chunks.out += text;
    },
  };
  return { chunks, output };
}

describe("CLI help", () => {
  it("prints help and exits 0 with no arguments", async () => {
    const { chunks, output } = captureOutput();

    const exitCode = await runCli([], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("vgen19");
    expect(chunks.out).toContain("help");
    expect(chunks.err).toBe("");
  });

  it("prints help and exits 0 for the help command", async () => {
    const { chunks, output } = captureOutput();

    const exitCode = await runCli(["help"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("vgen19");
    expect(chunks.err).toBe("");
  });

  it("prints help and exits 0 for --help", async () => {
    const { chunks, output } = captureOutput();

    const exitCode = await runCli(["--help"], output);

    expect(exitCode).toBe(0);
    expect(chunks.out).toContain("vgen19");
  });

  it("prints help to stderr and exits non-zero for an unknown command", async () => {
    const { chunks, output } = captureOutput();

    const exitCode = await runCli(["frobnicate"], output);

    expect(exitCode).not.toBe(0);
    expect(chunks.err).toContain("Unknown command");
    expect(chunks.err).toContain("frobnicate");
    expect(chunks.err).toContain("vgen19");
    expect(chunks.out).toBe("");
  });
});
