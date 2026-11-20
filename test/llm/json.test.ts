import { describe, expect, it } from "vitest";

import { parseJsonResponse } from "../../src/llm/json.js";
import { JsonValidationError, type JsonSchema } from "../../src/llm/types.js";

const draftSchema: JsonSchema = {
  properties: {
    links: { items: { type: "string" }, type: "array" },
    note: { type: "string" },
  },
  required: ["note"],
  type: "object",
};

describe("parseJsonResponse", () => {
  it("parses valid JSON matching the schema", () => {
    const parsed = parseJsonResponse<{ links: string[]; note: string }>(
      '{"note":"A sourced fact.","links":["https://example.com/a"]}',
      draftSchema,
    );

    expect(parsed.note).toBe("A sourced fact.");
    expect(parsed.links).toEqual(["https://example.com/a"]);
  });

  it("strips a markdown JSON fence before parsing", () => {
    const parsed = parseJsonResponse<{ note: string }>(
      '```json\n{"note":"Fenced."}\n```',
      {
        properties: { note: { type: "string" } },
        required: ["note"],
        type: "object",
      },
    );

    expect(parsed.note).toBe("Fenced.");
  });

  it("rejects malformed JSON with a clear error", () => {
    expect(() => parseJsonResponse('{"note": oops}', draftSchema)).toThrow(
      JsonValidationError,
    );
    expect(() => parseJsonResponse('{"note": oops}', draftSchema)).toThrow(
      /not valid JSON/,
    );
  });

  it("rejects a value whose type does not match the schema", () => {
    expect(() =>
      parseJsonResponse('{"note":42,"links":[]}', draftSchema),
    ).toThrow(/note.*string/);
  });

  it("rejects a value missing a required property", () => {
    expect(() => parseJsonResponse('{"links":[]}', draftSchema)).toThrow(
      /note.*required/,
    );
  });

  it("rejects an array item whose type does not match", () => {
    expect(() =>
      parseJsonResponse('{"note":"x","links":["ok",7]}', draftSchema),
    ).toThrow(/links\[1\].*string/);
  });

  it("rejects a value outside the allowed enum", () => {
    expect(() =>
      parseJsonResponse('"maybe"', {
        enum: ["yes", "no"],
        type: "string",
      }),
    ).toThrow(/allowed values/);
  });

  it("rejects an object with an unknown field, like the strict receipt parser", () => {
    expect(() =>
      parseJsonResponse('{"note":"x","links":[],"bonus":5}', draftSchema),
    ).toThrow(JsonValidationError);
    expect(() =>
      parseJsonResponse('{"note":"x","links":[],"bonus":5}', draftSchema),
    ).toThrow(/bonus/);
  });

  it("rejects an unknown field nested inside an array item", () => {
    expect(() =>
      parseJsonResponse(
        '{"findings":[{"claim":"A fact.","surprise":true}]}',
        {
          properties: {
            findings: {
              items: {
                properties: { claim: { type: "string" } },
                required: ["claim"],
                type: "object",
              },
              type: "array",
            },
          },
          required: ["findings"],
          type: "object",
        },
      ),
    ).toThrow(/surprise/);
  });

  it("never returns unvalidated output", () => {
    expect(() => parseJsonResponse("not json at all", draftSchema)).toThrow(
      JsonValidationError,
    );
  });
});
