/**
 * The routed model client: the one seam later tickets use to talk to a
 * model. It routes each call by task kind (cheap work to a fast model,
 * expensive work to a stronger model), tries the default provider
 * first and the fallback provider once on failure, and enforces a
 * per-cycle call budget. Fail-closed throughout: no retries past a
 * failure, no calls past the budget, no paid tier anywhere.
 *
 * One client instance owns one mining cycle's budget. The count resets
 * only when a new client is created for the next cycle.
 */

import { requireKey, type Vgen19Config } from "../config.js";
import { DEFAULT_MODEL_CALL_BUDGET } from "../policy/limits.js";
import { errorMessage } from "../util.js";
import { GeminiProvider } from "./gemini.js";
import type { FetchFn } from "./http.js";
import { OpenRouterProvider } from "./openrouter.js";
import type {
  ChatMessage,
  CompleteOptions,
  JsonSchema,
  ModelProvider,
  ModelTier,
  TaskKind,
} from "./types.js";
import { BudgetExhaustedError, ProviderError } from "./types.js";

export { DEFAULT_MODEL_CALL_BUDGET } from "../policy/limits.js";

/** Fast and strong model IDs for one provider. */
export interface ProviderModels {
  fast: string;
  strong: string;
}

export interface RoutedModelClientOptions {
  /** Default provider (Gemini). Tried first for every call. */
  primary: ModelProvider;
  /** Fallback provider (OpenRouter). Tried once when the default fails. */
  fallback?: ModelProvider;
  /** Model IDs per provider and tier. */
  models: {
    primary: ProviderModels;
    fallback?: ProviderModels;
  };
  /** Per-cycle call budget. Defaults to `DEFAULT_MODEL_CALL_BUDGET`. */
  budget?: number;
}

/**
 * Route a task kind to a model tier: triage and extraction are cheap
 * work for the fast model; drafting and judging need the stronger
 * model (spec story 28).
 */
export function route(taskKind: TaskKind): ModelTier {
  switch (taskKind) {
    case "triage":
    case "extraction":
      return "fast";
    case "drafting":
    case "judging":
      return "strong";
  }
}

export class RoutedModelClient {
  readonly budget: number;

  private readonly primary: ModelProvider;
  private readonly fallback: ModelProvider | undefined;
  private readonly models: RoutedModelClientOptions["models"];
  private used = 0;

  constructor(options: RoutedModelClientOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.models = options.models;
    this.budget = options.budget ?? DEFAULT_MODEL_CALL_BUDGET;
  }

  /** Model calls made so far in this cycle (primary and fallback attempts). */
  get callsUsed(): number {
    return this.used;
  }

  /** Model calls left in this cycle's budget. */
  get callsRemaining(): number {
    return Math.max(0, this.budget - this.used);
  }

  /** Chat completion for a task kind, routed and budgeted. */
  async completeChat(
    taskKind: TaskKind,
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<string> {
    const tier = route(taskKind);
    return this.attempt(tier, (provider, model) =>
      provider.completeChat(messages, { ...options, model }),
    );
  }

  /** Structured JSON output for a task kind, routed and budgeted. */
  async completeJson<T>(
    taskKind: TaskKind,
    messages: ChatMessage[],
    schema: JsonSchema,
    options: CompleteOptions = {},
  ): Promise<T> {
    const tier = route(taskKind);
    return this.attempt(tier, (provider, model) =>
      provider.completeJson<T>(messages, schema, { ...options, model }),
    );
  }

  /**
   * One logical call: try the default provider, then the fallback once.
   * An attempt spends one budget unit only once the provider call has
   * actually started (the provider returned a promise): a synchronous
   * throw, such as a provider refusing its model before any network
   * call, costs nothing. When both providers fail, the error names
   * both failures; there are no further retries. When the budget runs
   * out before the fallback can be attempted, the
   * `BudgetExhaustedError` carries the primary failure as its cause
   * instead of masking it.
   */
  private async attempt<T>(
    tier: ModelTier,
    run: (provider: ModelProvider, model: string) => Promise<T>,
  ): Promise<T> {
    let primaryError: unknown;
    try {
      return await this.tryOnce(() =>
        run(this.primary, this.models.primary[tier]),
      );
    } catch (error) {
      primaryError = error;
    }
    const fallback = this.fallback;
    const fallbackModels = this.models.fallback;
    if (fallback === undefined || fallbackModels === undefined) {
      throw primaryError;
    }
    try {
      return await this.tryOnce(() => run(fallback, fallbackModels[tier]));
    } catch (fallbackError) {
      if (fallbackError instanceof BudgetExhaustedError) {
        fallbackError.cause = primaryError;
        throw fallbackError;
      }
      throw new ProviderError(
        `Both model providers failed (${this.primary.name}: ` +
          `${errorMessage(primaryError)}; ${fallback.name}: ` +
          `${errorMessage(fallbackError)}).`,
      );
    }
  }

  /**
   * One attempt against the budget. The budget is checked before the
   * call and spent only once the provider call has actually started:
   * a synchronous throw means no call was attempted and costs
   * nothing, while an asynchronous failure still spent its unit.
   */
  private async tryOnce<T>(run: () => Promise<T>): Promise<T> {
    if (this.used >= this.budget) {
      throw new BudgetExhaustedError(this.used, this.budget);
    }
    // A synchronous throw means no call was attempted: it propagates
    // here, before the budget is spent.
    const promise = run();
    this.used += 1;
    return promise;
  }
}

export interface CreateRoutedClientOptions {
  /** Injectable fetch for both providers; defaults to the global fetch. */
  fetchFn?: FetchFn;
  /**
   * Injected providers, for tests. When a provider is injected, its key
   * is not required. Omit a fallback here and set no OpenRouter key to
   * build a primary-only client.
   */
  providers?: {
    primary?: ModelProvider;
    fallback?: ModelProvider;
  };
}

/**
 * Build a routed client from loaded config: Gemini as the default
 * provider and OpenRouter as the fallback when the Gemini key is set;
 * OpenRouter as the primary (with no fallback) when only the
 * OpenRouter key is set. The commands accept either key, so the
 * client must too: an OpenRouter-only setup runs, it does not fail
 * closed on a missing Gemini key. Fails closed naming both variables
 * only when neither key is set.
 */
export function createRoutedClient(
  config: Vgen19Config,
  options: CreateRoutedClientOptions = {},
): RoutedModelClient {
  const injectedPrimary = options.providers?.primary;
  const injectedFallback = options.providers?.fallback;

  let primary: ModelProvider;
  let primaryModels: ProviderModels;
  let openRouterIsPrimary = false;
  if (injectedPrimary !== undefined) {
    primary = injectedPrimary;
    primaryModels = {
      fast: config.geminiFastModel,
      strong: config.geminiStrongModel,
    };
  } else if (config.geminiApiKey !== undefined) {
    primary = new GeminiProvider({
      apiKey: requireKey(config.geminiApiKey, "GEMINI_API_KEY"),
      defaultModel: config.geminiFastModel,
      fetchFn: options.fetchFn,
    });
    primaryModels = {
      fast: config.geminiFastModel,
      strong: config.geminiStrongModel,
    };
  } else if (config.openrouterApiKey !== undefined) {
    primary = new OpenRouterProvider({
      apiKey: requireKey(config.openrouterApiKey, "OPENROUTER_API_KEY"),
      defaultModel: config.openrouterFastModel,
      fetchFn: options.fetchFn,
    });
    primaryModels = {
      fast: config.openrouterFastModel,
      strong: config.openrouterStrongModel,
    };
    openRouterIsPrimary = true;
  } else {
    throw new Error(
      "Missing required environment variable: GEMINI_API_KEY or " +
        "OPENROUTER_API_KEY. Set at least one before running this " +
        "command (see .env.example).",
    );
  }

  let fallback: ModelProvider | undefined;
  let fallbackModels: ProviderModels | undefined;
  if (injectedFallback !== undefined) {
    fallback = injectedFallback;
    fallbackModels = {
      fast: config.openrouterFastModel,
      strong: config.openrouterStrongModel,
    };
  } else if (
    !openRouterIsPrimary &&
    config.openrouterApiKey !== undefined
  ) {
    fallback = new OpenRouterProvider({
      apiKey: config.openrouterApiKey,
      defaultModel: config.openrouterFastModel,
      fetchFn: options.fetchFn,
    });
    fallbackModels = {
      fast: config.openrouterFastModel,
      strong: config.openrouterStrongModel,
    };
  }

  return new RoutedModelClient({
    budget: config.modelCallBudget,
    fallback,
    models: {
      fallback: fallbackModels,
      primary: primaryModels,
    },
    primary,
  });
}
