import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SCRIPTS = join(REPO_ROOT, "scripts");

/** Stub authd module: returns fake surrogates, never the real authd. */
const STUB_MODULE = `
def dynamic_credential_entry(name, entry_name="access_token", **kwargs):
    return {"name": entry_name, "surrogate": "hsurr:test-fake-" + name}
`;

/** Stub authd module that fails for the Gemini credential only. */
const FAILING_GEMINI_STUB_MODULE = `
class DynamicCredentialError(RuntimeError):
    pass

def dynamic_credential_entry(name, entry_name="access_token", **kwargs):
    if name == "custom.gemini":
        raise DynamicCredentialError("authd unreachable in test")
    return {"name": entry_name, "surrogate": "hsurr:test-fake-" + name}
`;

/** Stub authd module that fails for the Delphi credential only. */
const FAILING_DELPHI_STUB_MODULE = `
class DynamicCredentialError(RuntimeError):
    pass

def dynamic_credential_entry(name, entry_name="access_token", **kwargs):
    if name == "custom.delphi":
        raise DynamicCredentialError("authd unreachable in test")
    return {"name": entry_name, "surrogate": "hsurr:test-fake-" + name}
`;

/**
 * A fake compiled CLI. Appends one JSON line per invocation (argv
 * plus the env vars it received) to the marker file, prints a line,
 * and exits with FAKE_CLI_EXIT_CODE — or, for a `summary`
 * invocation, FAKE_CLI_SUMMARY_EXIT_CODE. The marker may hold the
 * fake surrogate: it is a test-only value in a temp dir, never a
 * real credential.
 */
const FAKE_CLI = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(
  process.env.FAKE_CLI_MARKER,
  JSON.stringify({
    argv,
    delphiApiKey: process.env.DELPHI_API_ACCESS_KEY ?? null,
    geminiApiKey: process.env.GEMINI_API_KEY ?? null,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? null,
    tavilyApiKey: process.env.TAVILY_API_KEY ?? null,
  }) + "\\n",
);
console.log("fake cycle output");
console.error("fake cycle error output");
const exitCode =
  argv[0] === "summary"
    ? Number(process.env.FAKE_CLI_SUMMARY_EXIT_CODE ?? "0")
    : Number(process.env.FAKE_CLI_EXIT_CODE ?? "0");
process.exit(exitCode);
`;

/** Fake npm: only `run build` works; it installs the fake CLI. */
const FAKE_NPM = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p dist
  cp "$FAKE_CLI_TEMPLATE" dist/cli.js
  echo "fake build done"
  exit 0
fi
echo "fake npm: unsupported invocation: $*" >&2
exit 1
`;

/**
 * Fake timeout: records its arguments (duration plus command) in
 * the marker file, drops the duration, and runs the command.
 */
const FAKE_TIMEOUT = `#!/bin/sh
echo "$*" >> "$FAKE_TIMEOUT_MARKER"
shift
exec "$@"
`;

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

interface FakeRepo {
  repoDir: string;
  dataDir: string;
  markerPath: string;
  cliTemplatePath: string;
  runScript: (
    env?: Record<string, string>,
  ) => Promise<{ code: number; stderr: string; stdout: string }>;
}

/**
 * Build a fake repo containing the REAL run script and surrogate
 * helper, a fake dist/cli.js (unless `withDist` is false), and a
 * stubbed authd module. The script is invoked exactly as the
 * scheduler would: `bash scripts/run-cycle.sh`.
 */
async function makeFakeRepo(options: {
  authdModule?: string;
  withDist?: boolean;
  extraBin?: Map<string, string>;
  restrictedPath?: boolean;
}): Promise<FakeRepo> {
  const repoDir = await makeTempDir("vgen19-fake-repo-");
  const dataDir = await makeTempDir("vgen19-fake-data-");
  const scriptsDir = join(repoDir, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  await copyFile(join(REAL_SCRIPTS, "run-cycle.sh"), join(scriptsDir, "run-cycle.sh"));
  await copyFile(
    join(REAL_SCRIPTS, "fetch-surrogate.py"),
    join(scriptsDir, "fetch-surrogate.py"),
  );

  const stubDir = await makeTempDir("vgen19-fake-authd-");
  await writeFile(
    join(stubDir, "dynamic_credentials.py"),
    options.authdModule ?? STUB_MODULE,
    "utf-8",
  );
  const emptyFallback = await makeTempDir("vgen19-fake-bin-");

  const markerPath = join(dataDir, "cli-marker.json");
  const cliTemplatePath = join(repoDir, "fake-cli-template.cjs");
  await writeFile(cliTemplatePath, FAKE_CLI, "utf-8");
  if (options.withDist !== false) {
    await mkdir(join(repoDir, "dist"), { recursive: true });
    await writeFile(join(repoDir, "dist", "cli.js"), FAKE_CLI, "utf-8");
  }

  // Extra commands on PATH (fake npm, or a restricted PATH without
  // node for the missing-node case).
  const binDir = await makeTempDir("vgen19-fake-path-");
  const pathEntries: string[] = [];
  if (options.extraBin !== undefined) {
    for (const [name, content] of options.extraBin) {
      const target = join(binDir, name);
      await writeFile(target, content, "utf-8");
      await chmod(target, 0o755);
    }
    pathEntries.push(binDir);
  }
  if (options.restrictedPath === true) {
    // A PATH with everything the script needs except node.
    for (const name of ["python3", "date", "mkdir", "dirname"]) {
      const { stdout } = await execFileAsync("which", [name]);
      await symlink(stdout.trim(), join(binDir, name));
    }
    pathEntries.push(binDir);
  } else {
    pathEntries.push(binDir, process.env["PATH"] ?? "");
  }

  const runScript = async (
    env: Record<string, string> = {},
  ): Promise<{ code: number; stderr: string; stdout: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync(
        "/bin/bash",
        [join(scriptsDir, "run-cycle.sh")],
        {
          cwd: repoDir,
          env: {
            ...process.env,
            DYNAMIC_CREDENTIALS_BIN: emptyFallback,
            FAKE_CLI_MARKER: markerPath,
            FAKE_CLI_TEMPLATE: cliTemplatePath,
            PATH: pathEntries.join(":"),
            PYTHONPATH:
              stubDir +
              (process.env["PYTHONPATH"] !== undefined
                ? `:${process.env["PYTHONPATH"]}`
                : ""),
            VGEN19_DATA_DIR: dataDir,
            ...env,
          },
        },
      );
      return { code: 0, stderr, stdout };
    } catch (error) {
      const failure = error as {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      return {
        code: typeof failure.code === "number" ? failure.code : -1,
        stderr: failure.stderr ?? "",
        stdout: failure.stdout ?? "",
      };
    }
  };

  return { cliTemplatePath, dataDir, markerPath, repoDir, runScript };
}

interface RunIndexEntry {
  cycleId: string;
  exitCode: number;
  finishedAt: string;
  logPath: string;
  startedAt: string;
  status: "ok" | "failed";
}

interface CliInvocation {
  argv: string[];
  delphiApiKey: string | null;
  geminiApiKey: string | null;
  openrouterApiKey: string | null;
  tavilyApiKey: string | null;
}

async function readCliInvocations(markerPath: string): Promise<CliInvocation[]> {
  const raw = await readFile(markerPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as CliInvocation);
}

async function readRunIndex(dataDir: string): Promise<RunIndexEntry[]> {
  const raw = await readFile(join(dataDir, "runs", "index.jsonl"), "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunIndexEntry);
}

async function readOnlyLog(dataDir: string): Promise<string> {
  const names = await readdir(join(dataDir, "runs"));
  const logs = names.filter((name) => name.endsWith(".log"));
  expect(logs).toHaveLength(1);
  return readFile(join(dataDir, "runs", logs[0]!), "utf-8");
}

describe("run-cycle.sh", () => {
  it("runs the cycle, logs it, and records an ok index entry", async () => {
    const fake = await makeFakeRepo({});

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(result.code).toBe(0);
    const invocations = await readCliInvocations(fake.markerPath);
    const marker = invocations[0]!;
    expect(marker.delphiApiKey).toBe("hsurr:test-fake-custom.delphi");
    expect(marker.geminiApiKey).toBe("hsurr:test-fake-custom.gemini");
    expect(marker.openrouterApiKey).toBe("hsurr:test-fake-custom.openrouter");
    expect(marker.tavilyApiKey).toBe("hsurr:test-fake-custom.tavily");
    const log = await readOnlyLog(fake.dataDir);
    expect(log).toContain("fake cycle output");
    expect(log).toContain("fake cycle error output");
    expect(log).not.toContain("hsurr:test-fake");
    expect(result.stdout).not.toContain("hsurr:test-fake");
    expect(result.stderr).not.toContain("hsurr:test-fake");
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ok");
    expect(entries[0]!.exitCode).toBe(0);
    expect(entries[0]!.cycleId).toMatch(/^cycle-\d{4}-\d{2}-\d{2}T/);
    expect(entries[0]!.logPath).toContain(entries[0]!.cycleId);
  });

  it("exits 0 when the cycle fails, and records a failed index entry", async () => {
    const fake = await makeFakeRepo({});

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "3" });

    // The scheduler must keep running later cycles, so a failed
    // cycle never fails the script.
    expect(result.code).toBe(0);
    const log = await readOnlyLog(fake.dataDir);
    expect(log).toContain("fake cycle output");
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("failed");
    expect(entries[0]!.exitCode).toBe(3);
  });

  it("runs a later cycle after a failed one", async () => {
    const fake = await makeFakeRepo({});

    const first = await fake.runScript({ FAKE_CLI_EXIT_CODE: "1" });
    const second = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.status)).toEqual([
      "failed",
      "ok",
    ]);
    // Two full script runs (each fetches four surrogates and runs
    // the CLI twice), so this test gets a longer timeout.
  }, 15000);

  it("exits non-zero and does not run the cycle when a surrogate fetch fails", async () => {
    const fake = await makeFakeRepo({ authdModule: FAILING_GEMINI_STUB_MODULE });

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("custom.gemini");
    expect(result.stderr).toMatch(/did not run|not run/i);
    await expect(readFile(fake.markerPath, "utf-8")).rejects.toThrow();
    await expect(readRunIndex(fake.dataDir)).rejects.toThrow();
  });

  it("exits non-zero and does not run the cycle when the Delphi fetch fails", async () => {
    const fake = await makeFakeRepo({ authdModule: FAILING_DELPHI_STUB_MODULE });

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("custom.delphi");
    expect(result.stderr).toMatch(/did not run|not run/i);
    await expect(readFile(fake.markerPath, "utf-8")).rejects.toThrow();
    await expect(readRunIndex(fake.dataDir)).rejects.toThrow();
  });

  it("runs a stub cycle without the Delphi fetch when VGEN19_DELPHI_STUB is set", async () => {
    // The Delphi fetch would fail here; stub mode must skip it
    // entirely and still run the cycle, without a Delphi key.
    const fake = await makeFakeRepo({ authdModule: FAILING_DELPHI_STUB_MODULE });

    const result = await fake.runScript({
      FAKE_CLI_EXIT_CODE: "0",
      VGEN19_DELPHI_STUB: "true",
    });

    expect(result.code).toBe(0);
    const invocations = await readCliInvocations(fake.markerPath);
    const marker = invocations[0]!;
    expect(marker.delphiApiKey).toBeNull();
    // The other providers are still fetched: stub mode only
    // skips Delphi, it does not change the rest of the cycle.
    expect(marker.geminiApiKey).toBe("hsurr:test-fake-custom.gemini");
    expect(marker.tavilyApiKey).toBe("hsurr:test-fake-custom.tavily");
    expect(marker.openrouterApiKey).toBe("hsurr:test-fake-custom.openrouter");
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ok");
  });

  it("builds first when dist/cli.js is missing, then runs the cycle", async () => {
    const fake = await makeFakeRepo({
      extraBin: new Map([["npm", FAKE_NPM]]),
      withDist: false,
    });

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(result.code).toBe(0);
    const built = await readFile(join(fake.repoDir, "dist", "cli.js"), "utf-8");
    expect(built).toContain("fake cycle output");
    const invocations = await readCliInvocations(fake.markerPath);
    const marker = invocations[0]!;
    expect(marker.geminiApiKey).toBe("hsurr:test-fake-custom.gemini");
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ok");
  });

  it("gives each run a unique cycle id, even within the same second", async () => {
    const fake = await makeFakeRepo({});

    await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });
    await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.cycleId).not.toBe(entries[1]!.cycleId);
    // Two full script runs (each fetches four surrogates and runs
    // the CLI twice), so this test gets a longer timeout.
  }, 15000);

  it("skips cleanly when another cycle holds the lock", async () => {
    const fake = await makeFakeRepo({});
    const runsDir = join(fake.dataDir, "runs");
    await mkdir(runsDir, { recursive: true });
    const lockPath = join(runsDir, "run-cycle.lock");
    // Hold the lock in a background process for the duration of
    // the run, then wait until it is actually held.
    const holder = spawn("flock", [lockPath, "sleep", "30"]);
    try {
      const deadline = Date.now() + 5000;
      let held = false;
      while (Date.now() < deadline && !held) {
        try {
          await execFileAsync("flock", ["-n", lockPath, "true"]);
        } catch {
          held = true;
        }
        if (!held) {
          await sleep(50);
        }
      }
      expect(held).toBe(true);

      const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

      expect(result.code).toBe(0);
      expect(result.stderr + result.stdout).toMatch(
        /another cycle is already running/i,
      );
      // The CLI never ran and no run was recorded (no index file
      // was even created).
      await expect(readFile(fake.markerPath, "utf-8")).rejects.toThrow();
      await expect(
        readFile(join(runsDir, "index.jsonl"), "utf-8"),
      ).rejects.toThrow();
    } finally {
      holder.kill();
    }
  });

  it("refreshes the running summary after the cycle, without credentials", async () => {
    const fake = await makeFakeRepo({});

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(result.code).toBe(0);
    const invocations = await readCliInvocations(fake.markerPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.argv[0]).toBe("mine");
    expect(invocations[1]!.argv).toEqual(["summary"]);
    // The summary is a local aggregation: it needs no API keys.
    expect(invocations[1]!.delphiApiKey).toBeNull();
    expect(invocations[1]!.geminiApiKey).toBeNull();
    expect(invocations[1]!.openrouterApiKey).toBeNull();
    expect(invocations[1]!.tavilyApiKey).toBeNull();
  });

  it("still exits 0 and records the cycle when the summary refresh fails", async () => {
    const fake = await makeFakeRepo({});

    const result = await fake.runScript({
      FAKE_CLI_EXIT_CODE: "0",
      FAKE_CLI_SUMMARY_EXIT_CODE: "1",
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/summary/i);
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ok");
  });

  it("runs the cycle under a 60-minute timeout backstop", async () => {    const fake = await makeFakeRepo({
      extraBin: new Map([["timeout", FAKE_TIMEOUT]]),
    });
    const timeoutMarker = join(fake.dataDir, "timeout-marker.txt");

    const result = await fake.runScript({
      FAKE_CLI_EXIT_CODE: "0",
      FAKE_TIMEOUT_MARKER: timeoutMarker,
    });

    expect(result.code).toBe(0);
    const recorded = await readFile(timeoutMarker, "utf-8");
    expect(recorded).toContain("60m");
    expect(recorded).toContain("mine");
    const entries = await readRunIndex(fake.dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("ok");
  });

  it("exits non-zero when node is missing", async () => {
    const fake = await makeFakeRepo({ restrictedPath: true });

    const result = await fake.runScript({ FAKE_CLI_EXIT_CODE: "0" });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/node/i);
    await expect(readFile(fake.markerPath, "utf-8")).rejects.toThrow();
  });
});
