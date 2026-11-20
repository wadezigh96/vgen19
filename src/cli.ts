/**
 * Command-line entry point for Vgen19.
 *
 * Commands live in a small registry: each command is a name, a one-line
 * description, and a handler that receives its arguments and returns an
 * exit code. Later tickets add subcommands (mine, summary) by
 * registering them here, without touching the dispatcher.
 */

import { fileURLToPath } from "node:url";

import { AGENT_NAME, HARNESS } from "./agent.js";
import { draftCommand } from "./commands/draft.js";
import { marketsCommand } from "./commands/markets.js";
import { mineCommand } from "./commands/mine.js";
import { researchCommand } from "./commands/research.js";
import { approveCommand, submitCommand } from "./commands/submit.js";
import { summaryCommand } from "./commands/summary.js";

export { AGENT_NAME, HARNESS };

export interface CliOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface CliCommand {
  name: string;
  description: string;
  run(args: string[], output: CliOutput): Promise<number> | number;
}

function helpText(): string {
  const lines = [...commands.values()].map(
    (command) => `  ${command.name.padEnd(12)} ${command.description}`,
  );
  return [
    `${AGENT_NAME} - Delphi evidence-mining agent`,
    "",
    "Usage: vgen19 <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `vgen19 help` to show this help.",
    "",
  ].join("\n");
}

const helpCommand: CliCommand = {
  description: "Show this help text.",
  name: "help",
  run(_args, output) {
    output.writeOut(helpText());
    return 0;
  },
};

/**
 * The command registry. Register new subcommands here; the dispatcher
 * below never needs to change.
 */
export const commands = new Map<string, CliCommand>([
  [helpCommand.name, helpCommand],
  [marketsCommand.name, marketsCommand],
  [researchCommand.name, researchCommand],
  [draftCommand.name, draftCommand],
  [approveCommand.name, approveCommand],
  [submitCommand.name, submitCommand],
  [mineCommand.name, mineCommand],
  [summaryCommand.name, summaryCommand],
]);

/**
 * Run the CLI with the given arguments. Returns the process exit code:
 * 0 on success (including help), non-zero for an unknown command.
 * Output goes through `output` so tests can capture it without
 * touching the real console.
 */
export async function runCli(
  argv: string[],
  output: CliOutput,
): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined || name === "--help" || name === "-h") {
    output.writeOut(helpText());
    return 0;
  }

  const command = commands.get(name);
  if (command === undefined) {
    output.writeErr(`Unknown command: ${name}\n\n${helpText()}`);
    return 1;
  }

  return command.run(args, output);
}

const processOutput: CliOutput = {
  writeErr(text: string) {
    process.stderr.write(text);
  },
  writeOut(text: string) {
    process.stdout.write(text);
  },
};

/** Entry point used when this file is run directly as a script. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, processOutput);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `vgen19 failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
