/**
 * Parsing and validation of structured model output. Model replies are
 * untrusted data: they are parsed as JSON, checked against the
 * caller-supplied schema, and rejected with a clear error when they do
 * not match. Unvalidated output is never returned.
 */

import { JsonValidationError, type JsonSchema } from "./types.js";

/** Remove a surrounding markdown fence (```json ... ```) if present. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function describePath(path: string): string {
  return path === "" ? "value" : path;
}

function validateValue(value: unknown, schema: JsonSchema, path: string): void {
  const where = describePath(path);
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        throw new JsonValidationError(
          `${where} must be a string, got ${typeof value}.`,
        );
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        throw new JsonValidationError(
          `${where} must be one of the allowed values (${schema.enum.join(", ")}), got "${value}".`,
        );
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new JsonValidationError(
          `${where} must be a number, got ${typeof value}.`,
        );
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new JsonValidationError(
          `${where} must be a boolean, got ${typeof value}.`,
        );
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        throw new JsonValidationError(
          `${where} must be an array, got ${typeof value}.`,
        );
      }
      value.forEach((item, index) => {
        validateValue(item, schema.items, `${where}[${index}]`);
      });
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new JsonValidationError(
          `${where} must be an object, got ${value === null ? "null" : typeof value}.`,
        );
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) {
          throw new JsonValidationError(
            `${where}.${key} is required but missing.`,
          );
        }
      }
      // Unknown fields are rejected, matching the strict receipt
      // parser: a model that invents a field fails loudly instead of
      // smuggling unvalidated data through.
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema.properties, key)) {
          throw new JsonValidationError(
            `${where}.${key} is not a known field.`,
          );
        }
      }
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (record[key] !== undefined) {
          validateValue(record[key], propertySchema, `${where}.${key}`);
        }
      }
      return;
    }
  }
}

/**
 * Parse model text as JSON and validate it against `schema`. Throws
 * `JsonValidationError` on malformed JSON or a schema mismatch.
 */
export function parseJsonResponse<T>(text: string, schema: JsonSchema): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text)) as unknown;
  } catch {
    throw new JsonValidationError(
      "Model output is not valid JSON and was rejected.",
    );
  }
  validateValue(parsed, schema, "");
  return parsed as T;
}
