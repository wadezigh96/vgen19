/**
 * Shared base for model providers. `completeJson` is implemented once
 * here: it asks the provider for a JSON-mode chat reply and then parses
 * and validates it, so no provider can return unvalidated output.
 * Concrete providers only implement `completeChat`.
 */

import { parseJsonResponse } from "./json.js";
import type {
  ChatMessage,
  CompleteOptions,
  JsonSchema,
  ModelProvider,
} from "./types.js";

export abstract class BaseModelProvider implements ModelProvider {
  abstract readonly name: string;

  abstract completeChat(
    messages: ChatMessage[],
    options?: CompleteOptions,
  ): Promise<string>;

  async completeJson<T>(
    messages: ChatMessage[],
    schema: JsonSchema,
    options?: CompleteOptions,
  ): Promise<T> {
    const text = await this.completeChat(messages, {
      ...options,
      jsonMode: true,
    });
    return parseJsonResponse<T>(text, schema);
  }
}
