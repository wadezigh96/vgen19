/**
 * Shared types for the Brain: the model-provider interface, the message
 * shape, task routing kinds, and the errors a model call can raise.
 *
 * Every model call in Vgen19 goes through a `ModelProvider`. Providers are
 * pluggable behind this interface (see ADR-0002): the default is a free
 * tier (Google AI Studio Gemini) and the fallback is a second free tier
 * (OpenRouter free models). There is no paid tier anywhere in this
 * codebase.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompleteOptions {
  /** Model ID to use for this call. Defaults to the provider's default. */
  model?: string;
  /** Sampling temperature, when the provider supports it. */
  temperature?: number;
  /** Maximum output tokens, when the provider supports it. */
  maxTokens?: number;
  /**
   * When true, ask the provider for a JSON-only reply (its native JSON
   * mode). Set by `completeJson`; callers use `completeJson` instead of
   * setting this by hand.
   */
  jsonMode?: boolean;
}

/**
 * The kinds of work the agent asks a model to do. Routing sends cheap
 * work (triage, extraction) to a fast model and expensive work
 * (drafting, judging) to a stronger model, so free-tier quotas last
 * the whole mining window (spec story 28).
 */
export type TaskKind = "triage" | "extraction" | "drafting" | "judging";

/** Fast (cheap) or strong (capable) model tier. */
export type ModelTier = "fast" | "strong";

/**
 * A small, dependency-free subset of JSON Schema: enough to validate
 * the structured output the agent relies on (drafts, judgments)
 * without pulling in a validation library.
 */
export type JsonSchema =
  | { type: "string"; enum?: string[] }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "array"; items: JsonSchema }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
    };

/**
 * One model provider: chat completion plus structured JSON output.
 * `completeJson` must never return unvalidated output: it throws on
 * malformed JSON or on a value that does not match the schema.
 */
export interface ModelProvider {
  /** Human-readable provider name, used in error messages and traces. */
  readonly name: string;
  completeChat(
    messages: ChatMessage[],
    options?: CompleteOptions,
  ): Promise<string>;
  completeJson<T>(
    messages: ChatMessage[],
    schema: JsonSchema,
    options?: CompleteOptions,
  ): Promise<T>;
}

/** A model call failed: network error, non-2xx status, or empty reply. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * The per-cycle model-call budget is exhausted. Thrown before another
 * call is made, never after; there are no retries past this point.
 */
export class BudgetExhaustedError extends Error {
  constructor(callsUsed: number, budget: number) {
    super(
      `Model-call budget exhausted: ${callsUsed} of ${budget} calls used ` +
        `in this mining cycle. No further model calls will be made.`,
    );
    this.name = "BudgetExhaustedError";
  }
}

/** Model output was not valid JSON or did not match the given schema. */
export class JsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonValidationError";
  }
}
