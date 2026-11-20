/**
 * Small shared helpers used across modules: error messages, argument
 * parsing, atomic file writes, currency formatting, and cycle-id
 * validation. Each helper used to be defined (sometimes twice, with
 * different behaviour) in the module that needed it; they live here
 * now so there is exactly one of each.
 */

import { rename, writeFile } from "node:fs/promises";

/** The message of an error, or the string form of a non-error value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trim a value; blank values count as absent. */
export function trimToUndefined(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" || trimmed === undefined ? undefined : trimmed;
}

/** Read a `--flag value` or `--flag=value` option from the args. */
export function readOption(
  args: string[],
  flag: string,
): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === flag) {
      return args[i + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Read the first positional argument, skipping flags and the values
 * of flags that take one. `valueFlags` names the flags of the calling
 * command that consume the next argument (for example `--cycle`):
 * without it, `vgen19 submit --cycle c1 <draft-id>` would mistake the
 * flag's value (`c1`) for the positional. `--flag=value` forms are
 * skipped as one argument, and everything after a bare `--` counts
 * as positional.
 */
export function readPositionalArg(
  args: string[],
  valueFlags: string[],
): string | undefined {
  const valueFlagSet = new Set(valueFlags);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      return args[i + 1];
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      continue;
    }
    if (valueFlagSet.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

/**
 * Write a file atomically: write to a temporary file in the same
 * directory, then rename it over the target, so an interrupted write
 * never leaves a half-written file behind. The caller creates the
 * directory first. The temp name carries the process id, so two
 * processes writing the same target never share a temp file.
 */
export async function writeFileAtomic(
  target: string,
  content: string,
): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf-8");
  await rename(temp, target);
}

/** Format a USDC amount, rounded to cents (no float artefacts). */
export function formatUsdc(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return `${rounded} USDC`;
}

/**
 * Reject a cycle id that could escape the data directory when it is
 * interpolated into a file path. Cycle ids are user input
 * (`vgen19 mine --cycle <id>`), and `cycle-` plus an ISO timestamp
 * (which carries `:` and `.`) is the normal shape, so the check
 * rejects only what is actually dangerous: empty ids, path
 * separators, and `..` segments. Throws with a clear message.
 */
export function assertValidCycleId(cycleId: string): void {
  if (
    cycleId === "" ||
    cycleId.includes("/") ||
    cycleId.includes("\\") ||
    cycleId.includes("..") ||
    cycleId === "."
  ) {
    throw new Error(
      `Invalid cycle id "${cycleId}": a cycle id must not be empty and ` +
        `must not contain "/", "\\", or "..".`,
    );
  }
}
