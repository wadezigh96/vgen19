/**
 * OpenRouter provider: the fallback model provider, on OpenRouter's
 * free models.
 *
 * Endpoint (verified 20 Nov 2026): POST
 * https://openrouter.ai/api/v1/chat/completions, OpenAI-compatible, with
 * an `Authorization: Bearer <key>` header; the reply text is
 * `choices[0].message.content`. Source: openrouter.ai model and API
 * reference pages, checked 20 Nov 2026.
 *
 * Free-tier guard: a model is free on OpenRouter only when its ID ends
 * in `:free`, or when it is the `openrouter/free` router that picks a
 * free model at random. This provider refuses any other model ID, at
 * construction and per call, so a misconfiguration can never turn into
 * a paid call. Free models rotate often; the configured IDs are the
 * ones verified on 20 Nov 2026 (see `loadConfig`).
 */

import { BaseModelProvider } from "./base.js";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  defaultFetch,
  type FetchFn,
} from "./http.js";
import type { ChatMessage, CompleteOptions } from "./types.js";
import { ProviderError } from "./types.js";
import { errorMessage } from "../util.js";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** Model used when a call does not name one. Must be a free model. */
  defaultModel: string;
  /** Injectable fetch; defaults to the global fetch. Tests stub this. */
  fetchFn?: FetchFn;
  /** Per-call timeout in milliseconds. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/** True when the model ID is a free OpenRouter model (or the router). */
export function isFreeOpenRouterModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}

function requireFreeModel(model: string): void {
  if (!isFreeOpenRouterModel(model)) {
    throw new Error(
      `Refusing non-free OpenRouter model "${model}": Vgen19 only ever ` +
        `calls free models (IDs ending in ":free", or "openrouter/free").`,
    );
  }
}

function extractText(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    return "";
  }
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first.message?.content;
  return typeof content === "string" ? content : "";
}

export class OpenRouterProvider extends BaseModelProvider {
  readonly name = "openrouter";

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterProviderOptions) {
    super();
    requireFreeModel(options.defaultModel);
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  }

  override async completeChat(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<string> {
    const model = options.model ?? this.defaultModel;
    requireFreeModel(model);

    const body: Record<string, unknown> = {
      messages: messages.map((message) => ({
        content: message.content,
        role: message.role,
      })),
      model,
    };
    if (options.jsonMode === true) {
      body["response_format"] = { type: "json_object" };
    }
    if (options.temperature !== undefined) {
      body["temperature"] = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      body["max_tokens"] = options.maxTokens;
    }

    let response;
    try {
      response = await this.fetchFn(OPENROUTER_CHAT_URL, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(
        `OpenRouter request failed: ${errorMessage(error)}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `OpenRouter request failed with status ${response.status}` +
          (detail === "" ? "." : `: ${detail.slice(0, 300)}`),
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new ProviderError(
        `OpenRouter returned invalid JSON: ${errorMessage(error)}`,
      );
    }
    const text = extractText(data);
    if (text === "") {
      throw new ProviderError("OpenRouter returned no text in its reply.");
    }
    return text;
  }
}
