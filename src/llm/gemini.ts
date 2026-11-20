/**
 * Gemini provider: the default model provider, on the Google AI Studio
 * free tier.
 *
 * Endpoint (verified 20 Nov 2026): POST
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * with the `x-goog-api-key` header. The `generateContent` shape is the
 * legacy Gemini API shape; Google keeps it fully supported with no
 * sunset date, while the newer Interactions API is the recommended
 * primary path for new projects. We use `generateContent` because it is
 * stateless and matches the chat-completion seam. Sources: Google's
 * Gemini API docs via apidog.com and blog.nixapi.com onboarding guides
 * for Gemini 3.8 Flash, checked 20 Nov 2026.
 *
 * Free-tier note: whether a call is free depends on the Google Cloud
 * project behind the key having no billing attached, not on the model
 * ID. The operator must use a no-billing AI Studio key. Model IDs are
 * configurable (see `loadConfig`); the defaults are the free models
 * Google names for new projects.
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

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiProviderOptions {
  apiKey: string;
  /** Model used when a call does not name one. */
  defaultModel: string;
  /** Injectable fetch; defaults to the global fetch. Tests stub this. */
  fetchFn?: FetchFn;
  /** Per-call timeout in milliseconds. Defaults to 60 seconds. */
  timeoutMs?: number;
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

/**
 * Map chat messages to Gemini `contents`: system messages become the
 * system instruction, `assistant` becomes `model`, and consecutive
 * same-role messages merge (Gemini wants alternating roles).
 */
function toGeminiContents(messages: ChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemTexts.push(message.content);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role) {
      last.parts.push({ text: message.content });
    } else {
      contents.push({ parts: [{ text: message.content }], role });
    }
  }

  return {
    contents,
    ...(systemTexts.length > 0
      ? { systemInstruction: { parts: [{ text: systemTexts.join("\n\n") }] } }
      : {}),
  };
}

function extractText(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    return "";
  }
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "";
  }
  const first = candidates[0] as {
    content?: { parts?: Array<{ text?: unknown }> };
  };
  const parts = first.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

export class GeminiProvider extends BaseModelProvider {
  readonly name = "gemini";

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(options: GeminiProviderOptions) {
    super();
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
    const { contents, systemInstruction } = toGeminiContents(messages);
    const generationConfig: Record<string, unknown> = {};
    if (options.jsonMode === true) {
      generationConfig["responseMimeType"] = "application/json";
    }
    if (options.temperature !== undefined) {
      generationConfig["temperature"] = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      generationConfig["maxOutputTokens"] = options.maxTokens;
    }

    const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
    let response;
    try {
      response = await this.fetchFn(url, {
        body: JSON.stringify({
          contents,
          generationConfig,
          ...(systemInstruction !== undefined ? { systemInstruction } : {}),
        }),
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(
        `Gemini request failed: ${errorMessage(error)}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(
        `Gemini request failed with status ${response.status}` +
          (detail === "" ? "." : `: ${detail.slice(0, 300)}`),
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new ProviderError(
        `Gemini returned invalid JSON: ${errorMessage(error)}`,
      );
    }
    const text = extractText(data);
    if (text === "") {
      throw new ProviderError("Gemini returned no text in its reply.");
    }
    return text;
  }
}
