/**
 * In-memory fake model provider for tests. Later tickets import it
 * from here so their tests never need a real key or the network.
 *
 * The fake plays a script of outcomes in order (text replies or
 * failures) and falls back to `replyFor` (a per-call reply chosen
 * from the messages, for example by task kind) once the script runs
 * out, then to `defaultText`. Every attempted call is recorded,
 * including failed ones, with its messages and the model that was
 * asked for.
 */

import { BaseModelProvider } from "./base.js";
import type { ChatMessage, CompleteOptions } from "./types.js";

export type FakeOutcome = { text: string } | { error: Error };

export interface FakeCall {
  messages: ChatMessage[];
  model: string | undefined;
  jsonMode: boolean;
}

export interface FakeModelProviderOptions {
  /** Outcomes played in order; when exhausted, `replyFor` or `defaultText` applies. */
  script?: FakeOutcome[];
  /**
   * Reply chosen from the call's messages once the script runs out
   * (for example one reply per task kind, keyed on the system
   * prompt). Returning `undefined` falls through to `defaultText`.
   */
  replyFor?: (messages: ChatMessage[]) => string | undefined;
  /** Reply once the script runs out and `replyFor` has no answer. Defaults to an empty string. */
  defaultText?: string;
}

export class FakeModelProvider extends BaseModelProvider {
  readonly name = "fake";

  /** Every attempted call, in order, including failed ones. */
  readonly calls: FakeCall[] = [];

  private readonly script: FakeOutcome[];
  private readonly replyFor:
    | ((messages: ChatMessage[]) => string | undefined)
    | undefined;
  private readonly defaultText: string;

  constructor(options: FakeModelProviderOptions = {}) {
    super();
    this.script = [...(options.script ?? [])];
    this.replyFor = options.replyFor;
    this.defaultText = options.defaultText ?? "";
  }

  /** Append a text reply to the end of the script. */
  queueText(text: string): void {
    this.script.push({ text });
  }

  /** Append a failure to the end of the script. */
  queueError(error: Error): void {
    this.script.push({ error });
  }

  override async completeChat(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<string> {
    this.calls.push({
      jsonMode: options.jsonMode ?? false,
      messages: structuredClone(messages),
      model: options.model,
    });
    const outcome = this.script.shift();
    if (outcome === undefined) {
      return this.replyFor?.(messages) ?? this.defaultText;
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.text;
  }
}
