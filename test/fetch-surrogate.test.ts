import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(REPO_ROOT, "scripts", "fetch-surrogate.py");

/** A stub authd module: returns a fake surrogate, never the real authd. */
const STUB_MODULE = `
def dynamic_credential_entry(name, entry_name="access_token", **kwargs):
    return {"name": entry_name, "surrogate": "hsurr:test-fake-" + name}
`;

/** A stub authd module that fails, the way a real authd outage would. */
const FAILING_STUB_MODULE = `
class DynamicCredentialError(RuntimeError):
    pass

def dynamic_credential_entry(name, entry_name="access_token", **kwargs):
    raise DynamicCredentialError("authd unreachable in test")
`;

/** A stub authd module that returns a non-dict entry. */
const NON_DICT_STUB_MODULE = `
def dynamic_credential_entry(name, entry_name="access_token", **kwargs):
    return "not-a-dict"
`;

let tempDirs: string[] = [];

async function makeDirWithModule(moduleSource?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgen19-surrogate-stub-"));
  tempDirs.push(dir);
  if (moduleSource !== undefined) {
    await writeFile(
      join(dir, "dynamic_credentials.py"),
      moduleSource,
      "utf-8",
    );
  }
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

async function runHelper(
  args: string[],
  stubDir: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  // DYNAMIC_CREDENTIALS_BIN points the helper's fallback import at
  // an empty test directory, so no test run can ever reach the real
  // authd module: the stub on PYTHONPATH is the only module visible.
  const emptyFallback = await makeDirWithModule();
  try {
    const { stdout, stderr } = await execFileAsync(
      "python3",
      [HELPER, ...args],
      {
        env: {
          ...process.env,
          DYNAMIC_CREDENTIALS_BIN: emptyFallback,
          PYTHONPATH:
            stubDir +
            (process.env["PYTHONPATH"] !== undefined
              ? `:${process.env["PYTHONPATH"]}`
              : ""),
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
}

describe("fetch-surrogate.py", () => {
  it("prints only the surrogate from a stubbed authd module", async () => {
    const stubDir = await makeDirWithModule(STUB_MODULE);

    const result = await runHelper(["custom.gemini"], stubDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hsurr:test-fake-custom.gemini\n");
    expect(result.stderr).toBe("");
  });

  it("fetches the named credential, not a hardcoded one", async () => {
    const stubDir = await makeDirWithModule(STUB_MODULE);

    const result = await runHelper(["custom.tavily"], stubDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hsurr:test-fake-custom.tavily\n");
  });

  it("exits non-zero with a clear error when authd fails", async () => {
    const stubDir = await makeDirWithModule(FAILING_STUB_MODULE);

    const result = await runHelper(["custom.gemini"], stubDir);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("custom.gemini");
    expect(result.stderr).toMatch(/failed|error/i);
  });

  it("exits non-zero with a clear error when authd returns a non-dict entry", async () => {
    const stubDir = await makeDirWithModule(NON_DICT_STUB_MODULE);

    const result = await runHelper(["custom.gemini"], stubDir);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("custom.gemini");
    expect(result.stderr).toMatch(/failed|error/i);
    // A clean error message, not an uncaught traceback.
    expect(result.stderr).not.toContain("Traceback");
  });

  it("exits non-zero with usage help when no credential name is given", async () => {
    const stubDir = await makeDirWithModule(STUB_MODULE);

    const result = await runHelper([], stubDir);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/usage/i);
  });

  it("exits non-zero when the authd module cannot be imported at all", async () => {
    // No stub module anywhere: PYTHONPATH and the fallback bin dir
    // are both empty, so the import must fail cleanly.
    const emptyDir = await makeDirWithModule();

    const result = await runHelper(["custom.gemini"], emptyDir);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("custom.gemini");
    expect(result.stderr).toMatch(/failed|error/i);
  });
});
