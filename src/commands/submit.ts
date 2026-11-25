/**
 * The `submit` and `approve` commands.
 *
 * `submit <draft-id>` sends one approved draft to Delphi through the
 * adapter (the live client when a key is configured, the stub
 * otherwise), prints the receipt (verdict, rationale, reward) and
 * the new draft status, and exits 0 only on an accepted submission. A refusal
 * (cap, gate, not-approved status) or a rejected receipt exits
 * non-zero with a clear message. The cycle id defaults to a fresh
 * `manual-<timestamp>` unless `--cycle <id>` is given.
 *
 * `approve <draft-id> [--note "..."]` records a human approval for
 * one draft, which the approval gate requires before the draft may
 * be sent. Approval is per-draft, not per-market.
 */

import type { CliCommand, CliOutput } from "../cli.js";
import {
  loadProcessConfig,
  primaryStrongModel,
  type Vgen19Config,
} from "../config.js";
import type { DelphiAdapter } from "../delphi/adapter.js";
import { createConfiguredDelphiAdapter } from "../delphi/index.js";
import type { EvidenceDraft } from "../draft/types.js";
import { MemoryStore } from "../memory/store.js";
import { approveDraft } from "../submit/approvals.js";
import { submitDraft } from "../submit/submitter.js";
import type { SubmissionReceipt } from "../submit/types.js";
import {
  assertValidCycleId,
  errorMessage,
  readOption,
  readPositionalArg,
} from "../util.js";

export interface SubmitCommandOverrides {
  /** Memory store, for tests. Defaults to the configured data dir. */
  store?: MemoryStore;
  /** Delphi adapter, for tests. Defaults to the configured adapter (live client with a key, stub without). */
  adapter?: DelphiAdapter;
  /** Config, for tests. Defaults to the process environment. */
  config?: Vgen19Config;
  /**
   * Model id sent with the request. Defaults to the strong drafting
   * model: drafting goes to the strong model.
   */
  model?: string;
  /** Clock seam for the default manual cycle id. */
  now?: () => Date;
}

export interface ApproveCommandOverrides {
  /** Memory store, for tests. Defaults to the configured data dir. */
  store?: MemoryStore;
  /** Config, for tests. Defaults to the process environment. */
  config?: Vgen19Config;
  /** Clock seam for the approval timestamp. */
  now?: () => Date;
}

function formatReward(receipt: SubmissionReceipt): string {
  const reward = receipt.reward;
  if (reward === undefined) {
    return "none yet";
  }
  const parts: string[] = [];
  if (reward.judgment !== undefined) {
    parts.push(`judgment ${reward.judgment} ${reward.currency}`);
  }
  if (reward.settlement !== undefined) {
    parts.push(`settlement ${reward.settlement} ${reward.currency}`);
  }
  return parts.length > 0 ? parts.join(", ") : "none yet";
}

function formatReceipt(
  draft: EvidenceDraft,
  receipt: SubmissionReceipt,
  cycleId: string,
  draftStatus: string,
): string {
  const lines = [
    `Submission: ${receipt.submissionId} | Draft: ${draft.id} | Market: ${draft.marketId} | Cycle: ${cycleId}`,
    `Verdict: ${receipt.verdict.toUpperCase()}`,
  ];
  if (receipt.rationale !== undefined) {
    lines.push(`Rationale: ${receipt.rationale}`);
  }
  lines.push(`Reward: ${formatReward(receipt)}`);
  lines.push(`Draft status: ${draftStatus.toUpperCase()}`);
  lines.push("");
  return lines.join("\n");
}

export function createSubmitCommand(
  overrides: SubmitCommandOverrides = {},
): CliCommand {
  return {
    description: "Submit one approved draft to Delphi.",
    name: "submit",
    async run(args, output: CliOutput) {
      // Skip the value after --cycle when scanning for the positional:
      // `submit --cycle c1 <draft-id>` must look up the draft id, not c1.
      const draftId = readPositionalArg(args, ["--cycle"]);
      if (draftId === undefined) {
        output.writeErr(
          "Usage: vgen19 submit <draft-id> [--cycle <id>]\n" +
            "The draft must be approved (self-review pass) and, while the " +
            "approval gate is on, human-approved: " +
            "run `vgen19 approve <draft-id>` first.\n",
        );
        return 1;
      }

      try {
        const config = overrides.config ?? loadProcessConfig();
        const store =
          overrides.store ?? new MemoryStore(config.dataDir);
        const adapter =
          overrides.adapter ??
          createConfiguredDelphiAdapter(primaryStrongModel(config), {
            apiKey: config.delphiApiKey,
          });
        const now = overrides.now ?? (() => new Date());

        const draft = await store.loadDraft(draftId);
        if (draft === undefined) {
          output.writeErr(`Draft not found: ${draftId}.\n`);
          return 1;
        }

        const cycleId =
          readOption(args, "--cycle") ?? `manual-${now().toISOString()}`;
        assertValidCycleId(cycleId);
        const { receipt, submission } = await submitDraft(draft, {
          adapter,
          approvalGate: config.approvalGate,
          cycleId,
          maxSubmissionsPerCycle: config.maxSubmissionsPerCycle,
          model: overrides.model ?? primaryStrongModel(config),
          now: () => now(),
          store,
          warn: (message: string) => output.writeErr(`${message}\n`),
        });

        const savedDraft = await store.loadDraft(draft.id);
        const status = savedDraft?.status ?? draft.status;
        if (receipt.verdict === "rejected") {
          output.writeOut(
            `Delphi rejected draft ${draft.id}.\n` +
              formatReceipt(draft, receipt, submission.cycleId, status) +
              "The draft stays approved and may be retried in a later cycle.\n",
          );
          return 1;
        }
        output.writeOut(
          `Submitted draft ${draft.id} to Delphi.\n` +
            formatReceipt(draft, receipt, submission.cycleId, status),
        );
        return 0;
      } catch (error) {
        output.writeErr(`submit failed: ${errorMessage(error)}\n`);
        return 1;
      }
    },
  };
}

/** The `submit` command with live wiring, as registered in the CLI. */
export const submitCommand: CliCommand = createSubmitCommand();

export function createApproveCommand(
  overrides: ApproveCommandOverrides = {},
): CliCommand {
  return {
    description: "Approve one draft for submission (human approval).",
    name: "approve",
    async run(args, output: CliOutput) {
      // Skip the value after --note when scanning for the positional:
      // `approve --note "..." <draft-id>` must approve the draft id.
      const draftId = readPositionalArg(args, ["--note"]);
      if (draftId === undefined) {
        output.writeErr(
          'Usage: vgen19 approve <draft-id> [--note "..."]\n' +
            "Approvals are per-draft: the approval gate requires one " +
            "before the draft may be submitted.\n",
        );
        return 1;
      }

      try {
        const config = overrides.config ?? loadProcessConfig();
        const store =
          overrides.store ?? new MemoryStore(config.dataDir);
        const now = overrides.now ?? (() => new Date());
        const note = readOption(args, "--note");

        const approval = await approveDraft(store, draftId, note, {
          now: () => now(),
        });
        const draft = await store.loadDraft(draftId);
        const lines = [
          `Approved draft ${draftId}` +
            (draft !== undefined ? ` for market ${draft.marketId}` : "") +
            ".",
          `Approved by: ${approval.approvedBy} | At: ${approval.approvedAt}`,
        ];
        if (approval.note !== undefined) {
          lines.push(`Note: ${approval.note}`);
        }
        lines.push(
          `Draft status: ${(draft?.status ?? "unknown").toUpperCase()}`,
        );
        if (draft?.status !== "approved") {
          lines.push(
            "This draft still needs to pass self-review (status " +
              `"approved") before it can be submitted.`,
          );
        }
        lines.push("");
        output.writeOut(lines.join("\n"));
        return 0;
      } catch (error) {
        output.writeErr(`approve failed: ${errorMessage(error)}\n`);
        return 1;
      }
    },
  };
}

/** The `approve` command with live wiring, as registered in the CLI. */
export const approveCommand: CliCommand = createApproveCommand();
