/**
 * The Brain: model providers, routing, and the per-cycle budget.
 * Later tickets import the routed client and the fake provider from
 * here; the live providers stay behind the `createRoutedClient`
 * factory so no module constructs one by hand.
 */

export { BaseModelProvider } from "./base.js";
export {
  createRoutedClient,
  DEFAULT_MODEL_CALL_BUDGET,
  route,
  RoutedModelClient,
  type CreateRoutedClientOptions,
  type ProviderModels,
  type RoutedModelClientOptions,
} from "./client.js";
export {
  FakeModelProvider,
  type FakeCall,
  type FakeModelProviderOptions,
  type FakeOutcome,
} from "./fake.js";
export { GeminiProvider, type GeminiProviderOptions } from "./gemini.js";
export {
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from "./http.js";
export type { FetchFn, FetchInit, FetchResponse } from "./http.js";
export { parseJsonResponse } from "./json.js";
export {
  isFreeOpenRouterModel,
  OpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./openrouter.js";
export {
  BudgetExhaustedError,
  JsonValidationError,
  ProviderError,
  type ChatMessage,
  type ChatRole,
  type CompleteOptions,
  type JsonSchema,
  type ModelProvider,
  type ModelTier,
  type TaskKind,
} from "./types.js";
