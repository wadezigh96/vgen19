/**
 * Configuration for Vgen19. Configuration comes only from environment
 * variables (see `.env.example`); secrets are never committed, logged,
 * or printed.
 *
 * API keys are optional at load time: a mining cycle only needs the key
 * for the provider it actually uses. Code that needs a key calls
 * `requireKey` at the point of use, which fails closed with a clear
 * message naming the missing variable instead of running without it.
 */

import { DEFAULT_TAVILY_SEARCH_ENDPOINT } from "./search/tavily.js";
import { trimToUndefined as clean } from "./util.js";

export interface Vgen19Config {
  /**
   * Delphi API key. Required only when live mode talks to Delphi.
   * From `DELPHI_API_ACCESS_KEY` (the documented variable);
   * `DELPHI_API_KEY` works as an alias. The same key authenticates
   * both placements: Bearer for evidence calls, `X-API-Key` for
   * reads — unless `delphiReadApiKey` is set.
   */
  delphiApiKey?: string;
  /**
   * Optional separate key for Delphi reads only, from
   * `DELPHI_API_READ_KEY`. The escape hatch for the read placement
   * (see the placement note in `src/delphi/live.ts`): when set,
   * reads send this key as `X-API-Key` while evidence calls still
   * use `delphiApiKey` as Bearer.
   */
  delphiReadApiKey?: string;
  /** Google AI Studio (Gemini) API key, the default model provider. */
  geminiApiKey?: string;
  /** Fast Gemini model for triage and extraction. */
  geminiFastModel: string;
  /** Strong Gemini model for drafting and judging. */
  geminiStrongModel: string;
  /** OpenRouter API key, the fallback model provider. */
  openrouterApiKey?: string;
  /** Fast OpenRouter model for triage and extraction. */
  openrouterFastModel: string;
  /** Strong OpenRouter model for drafting and judging. */
  openrouterStrongModel: string;
  /** Tavily API key, the default search provider. */
  tavilyApiKey?: string;
  /** Tavily search endpoint. Defaults to the verified search URL. */
  tavilySearchEndpoint: string;
  /** Max search queries per market in one research run. */
  maxSearchesPerMarket?: number;
  /** Max source pages read per market in one research run. */
  maxPagesPerMarket?: number;
  /** Max model calls per market in one research run. */
  maxModelCallsPerMarket?: number;
  /** Context budget for research notes, in characters. */
  notesCharBudget?: number;
  /** Directory for long-term JSON storage. Defaults to `./data`. */
  dataDir: string;
  /** When true, the first submissions wait for human approval. */
  approvalGate: boolean;
  /** When true, a mining cycle drafts evidence without submitting. */
  dryRun: boolean;
  /** Maximum markets worked in one mining cycle. */
  maxMarketsPerCycle?: number;
  /** Maximum submissions sent in one mining cycle. */
  maxSubmissionsPerCycle?: number;
  /** Maximum model calls allowed in one mining cycle. */
  modelCallBudget?: number;
  /**
   * Per-cycle time budget in minutes. The runner stops picking new
   * markets once the deadline passes and finishes normally.
   * Defaults to 45.
   */
  cycleTimeBudgetMinutes?: number;
  /** Self-review pass threshold for the overall rubric score (0, 1]. Defaults to 0.7. */
  reviewPassThreshold: number;
}

export type EnvRecord = Record<string, string | undefined>;

/**
 * Default free model IDs, verified 20 November 2026. Every ID is
 * overridable via its environment variable; if a provider retires a
 * model, the operator sets a new ID without a code change.
 *
 * Gemini (Google AI Studio free tier): Google's pricing page lists
 * `gemini-3.8-flash` and `gemini-3.5-flash-lite` as "Free of charge"
 * and names them for new projects; the older 2.5 models are deprecated
 * and limited to existing users, so they are not used. Sources:
 * aifreeapi.com Gemini free-tier guide (checked 11 Nov 2026) and
 * blog.laozhang.ai (checked 27 Oct 2026).
 *
 * OpenRouter (free models): both IDs carry the `:free` suffix and were
 * listed with zero input/output prices in OpenRouter's own models API;
 * the Lightning model is the fast high-throughput one and the Ultra
 * model is the largest free reasoning model, and both answered every
 * live probe. Sources: teamday.ai OpenRouter free-models guide
 * (checked 28-30 Oct 2026) and hivra.cloud (Nov 2026).
 */
export const DEFAULT_GEMINI_FAST_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_STRONG_MODEL = "gemini-3.8-flash";
export const DEFAULT_OPENROUTER_FAST_MODEL =
  "nvidia/nemotron-3.5-lightning:free";
export const DEFAULT_OPENROUTER_STRONG_MODEL =
  "nvidia/nemotron-3-ultra-550b-a55b:free";

function parseBoolean(
  value: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  const cleaned = clean(value);
  if (cleaned === undefined) {
    return fallback;
  }
  if (cleaned === "true") {
    return true;
  }
  if (cleaned === "false") {
    return false;
  }
  throw new Error(
    `Invalid value for ${name}: expected "true" or "false", got "${cleaned}".`,
  );
}

function parsePositiveInt(
  value: string | undefined,
  name: string,
): number | undefined {
  const cleaned = clean(value);
  if (cleaned === undefined) {
    return undefined;
  }
  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid value for ${name}: expected a positive integer, got "${cleaned}".`,
    );
  }
  return parsed;
}

function parseThreshold(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const cleaned = clean(value);
  if (cleaned === undefined) {
    return fallback;
  }
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(
      `Invalid value for ${name}: expected a number in (0, 1], got "${cleaned}".`,
    );
  }
  return parsed;
}

/**
 * Build a typed config from an environment record. Pure: it reads only
 * the record it is given, never `process.env` directly, so tests can
 * pass any environment without touching the real one.
 *
 * Missing optional keys do not fail here; they fail closed at the point
 * of use via `requireKey`.
 */
export function loadConfig(env: EnvRecord): Vgen19Config {
  return {
    approvalGate: parseBoolean(
      env["VGEN19_APPROVAL_GATE"],
      "VGEN19_APPROVAL_GATE",
      true,
    ),
    dataDir: clean(env["VGEN19_DATA_DIR"]) ?? "./data",
    delphiApiKey:
      clean(env["DELPHI_API_ACCESS_KEY"]) ?? clean(env["DELPHI_API_KEY"]),
    delphiReadApiKey: clean(env["DELPHI_API_READ_KEY"]),
    dryRun: parseBoolean(env["VGEN19_DRY_RUN"], "VGEN19_DRY_RUN", false),
    geminiApiKey: clean(env["GEMINI_API_KEY"]),
    geminiFastModel:
      clean(env["GEMINI_FAST_MODEL"]) ?? DEFAULT_GEMINI_FAST_MODEL,
    geminiStrongModel:
      clean(env["GEMINI_STRONG_MODEL"]) ?? DEFAULT_GEMINI_STRONG_MODEL,
    maxMarketsPerCycle: parsePositiveInt(
      env["VGEN19_MAX_MARKETS_PER_CYCLE"],
      "VGEN19_MAX_MARKETS_PER_CYCLE",
    ),
    maxModelCallsPerMarket: parsePositiveInt(
      env["VGEN19_MAX_MODEL_CALLS_PER_MARKET"],
      "VGEN19_MAX_MODEL_CALLS_PER_MARKET",
    ),
    maxPagesPerMarket: parsePositiveInt(
      env["VGEN19_MAX_PAGES_PER_MARKET"],
      "VGEN19_MAX_PAGES_PER_MARKET",
    ),
    maxSearchesPerMarket: parsePositiveInt(
      env["VGEN19_MAX_SEARCHES_PER_MARKET"],
      "VGEN19_MAX_SEARCHES_PER_MARKET",
    ),
    maxSubmissionsPerCycle: parsePositiveInt(
      env["VGEN19_MAX_SUBMISSIONS_PER_CYCLE"],
      "VGEN19_MAX_SUBMISSIONS_PER_CYCLE",
    ),
    modelCallBudget: parsePositiveInt(
      env["VGEN19_MODEL_CALL_BUDGET"],
      "VGEN19_MODEL_CALL_BUDGET",
    ),
    cycleTimeBudgetMinutes: parsePositiveInt(
      env["VGEN19_CYCLE_TIME_BUDGET_MINUTES"],
      "VGEN19_CYCLE_TIME_BUDGET_MINUTES",
    ),
    notesCharBudget: parsePositiveInt(
      env["VGEN19_NOTES_CHAR_BUDGET"],
      "VGEN19_NOTES_CHAR_BUDGET",
    ),
    openrouterApiKey: clean(env["OPENROUTER_API_KEY"]),
    openrouterFastModel:
      clean(env["OPENROUTER_FAST_MODEL"]) ?? DEFAULT_OPENROUTER_FAST_MODEL,
    openrouterStrongModel:
      clean(env["OPENROUTER_STRONG_MODEL"]) ??
      DEFAULT_OPENROUTER_STRONG_MODEL,
    reviewPassThreshold: parseThreshold(
      env["VGEN19_REVIEW_PASS_THRESHOLD"],
      "VGEN19_REVIEW_PASS_THRESHOLD",
      0.7,
    ),
    tavilyApiKey: clean(env["TAVILY_API_KEY"]),
    tavilySearchEndpoint:
      clean(env["TAVILY_SEARCH_ENDPOINT"]) ?? DEFAULT_TAVILY_SEARCH_ENDPOINT,
  };
}

/**
 * The strong model id of the primary provider, for the identity sent
 * with Delphi requests: Gemini's strong model when the Gemini key is
 * set, else OpenRouter's. Mirrors `createRoutedClient`'s choice of
 * primary, so an OpenRouter-only setup never reports a Gemini model
 * it never used.
 */
export function primaryStrongModel(config: Vgen19Config): string {
  return config.geminiApiKey !== undefined
    ? config.geminiStrongModel
    : config.openrouterStrongModel;
}

/**
 * Return a key that must be present, or fail closed with a clear message
 * naming the missing environment variable. Call this at the point of use,
 * not at startup, so a missing key only blocks the feature that needs it.
 */
export function requireKey(
  value: string | undefined,
  envVar: string,
): string {
  const cleaned = clean(value);
  if (cleaned === undefined) {
    throw new Error(
      `Missing required environment variable: ${envVar}. ` +
        `Set it before running this command (see .env.example).`,
    );
  }
  return cleaned;
}

/** Load the config for the running process. */
export function loadProcessConfig(): Vgen19Config {
  return loadConfig(process.env);
}
