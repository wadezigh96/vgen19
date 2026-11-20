import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_CALL_BUDGET,
  route,
  RoutedModelClient,
} from "../../src/llm/client.js";
import { FakeModelProvider } from "../../src/llm/fake.js";
import {
  BudgetExhaustedError,
  ProviderError,
} from "../../src/llm/types.js";

const MODELS = {
  fallback: { fast: "or-fast:free", strong: "or-strong:free" },
  primary: { fast: "gem-fast", strong: "gem-strong" },
};

function makeClient(options: {
  budget?: number;
  fallbackScript?: Array<{ text: string } | { error: Error }>;
  primaryScript?: Array<{ text: string } | { error: Error }>;
  withFallback?: boolean;
} = {}) {
  const primary = new FakeModelProvider({
    defaultText: "primary reply",
    script: options.primaryScript ?? [],
  });
  const fallback = new FakeModelProvider({
    defaultText: "fallback reply",
    script: options.fallbackScript ?? [],
  });
  const client = new RoutedModelClient({
    budget: options.budget,
    fallback: options.withFallback === false ? undefined : fallback,
    models: MODELS,
    primary,
  });
  return { client, fallback, primary };
}

const USER_MESSAGE = [{ content: "Work on this market.", role: "user" }] as const;

describe("route", () => {
  it("sends triage and extraction to the fast model", () => {
    expect(route("triage")).toBe("fast");
    expect(route("extraction")).toBe("fast");
  });

  it("sends drafting and judging to the stronger model", () => {
    expect(route("drafting")).toBe("strong");
    expect(route("judging")).toBe("strong");
  });
});

describe("RoutedModelClient routing", () => {
  it("uses the fast primary model for triage and extraction", async () => {
    const { client, primary } = makeClient();

    await client.completeChat("triage", [...USER_MESSAGE]);
    await client.completeChat("extraction", [...USER_MESSAGE]);

    expect(primary.calls.map((call) => call.model)).toEqual([
      "gem-fast",
      "gem-fast",
    ]);
  });

  it("uses the strong primary model for drafting and judging", async () => {
    const { client, primary } = makeClient();

    await client.completeChat("drafting", [...USER_MESSAGE]);
    await client.completeChat("judging", [...USER_MESSAGE]);

    expect(primary.calls.map((call) => call.model)).toEqual([
      "gem-strong",
      "gem-strong",
    ]);
  });

  it("routes structured JSON calls by task kind too", async () => {
    const { client, primary } = makeClient({
      primaryScript: [{ text: '{"verdict":"yes"}' }],
    });

    await client.completeJson(
      "judging",
      [...USER_MESSAGE],
      {
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
        type: "object",
      },
    );

    expect(primary.calls[0]?.model).toBe("gem-strong");
    expect(primary.calls[0]?.jsonMode).toBe(true);
  });
});

describe("RoutedModelClient fallback", () => {
  it("uses the fallback provider when the default fails", async () => {
    const { client, fallback, primary } = makeClient({
      primaryScript: [{ error: new Error("Gemini down") }],
    });

    const reply = await client.completeChat("triage", [...USER_MESSAGE]);

    expect(reply).toBe("fallback reply");
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(fallback.calls[0]?.model).toBe("or-fast:free");
  });

  it("falls back to the strong fallback model for drafting", async () => {
    const { client, fallback } = makeClient({
      primaryScript: [{ error: new Error("Gemini down") }],
    });

    await client.completeChat("drafting", [...USER_MESSAGE]);

    expect(fallback.calls[0]?.model).toBe("or-strong:free");
  });

  it("throws a clear error when both providers fail, with no further retries", async () => {
    const { client, fallback, primary } = makeClient({
      fallbackScript: [
        { error: new Error("OpenRouter down") },
        { error: new Error("OpenRouter down") },
      ],
      primaryScript: [
        { error: new Error("Gemini down") },
        { error: new Error("Gemini down") },
      ],
    });

    const firstError = await client
      .completeChat("triage", [...USER_MESSAGE])
      .catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(ProviderError);
    expect((firstError as Error).message).toMatch(/Gemini down/);
    expect((firstError as Error).message).toMatch(/OpenRouter down/);

    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(ProviderError);

    // One attempt per provider per call: no retries.
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(2);
  });

  it("throws the default error directly when no fallback is configured", async () => {
    const { client } = makeClient({
      primaryScript: [{ error: new Error("Gemini down") }],
      withFallback: false,
    });

    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(/Gemini down/);
  });
});

describe("RoutedModelClient budget", () => {
  it("stops calls at the budget limit with no further attempt", async () => {
    const { client, primary } = makeClient({ budget: 2 });

    await client.completeChat("triage", [...USER_MESSAGE]);
    await client.completeChat("triage", [...USER_MESSAGE]);

    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(BudgetExhaustedError);
    expect(primary.calls).toHaveLength(2);
    expect(client.callsUsed).toBe(2);
    expect(client.callsRemaining).toBe(0);
  });

  it("counts a fallback attempt against the budget too", async () => {
    const { client, fallback, primary } = makeClient({
      budget: 2,
      primaryScript: [{ error: new Error("Gemini down") }],
    });

    // One logical call, two model attempts: budget spent in full.
    await client.completeChat("triage", [...USER_MESSAGE]);

    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(client.callsUsed).toBe(2);
    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(BudgetExhaustedError);
  });

  it("counts failed calls against the budget", async () => {
    const { client } = makeClient({
      budget: 1,
      fallbackScript: [{ error: new Error("OpenRouter down") }],
      primaryScript: [{ error: new Error("Gemini down") }],
    });

    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(BudgetExhaustedError);
    expect(client.callsUsed).toBe(1);
  });

  it("chains the primary failure as the cause when the budget runs out before the fallback", async () => {
    const { client } = makeClient({
      budget: 1,
      primaryScript: [{ error: new Error("Gemini down") }],
    });

    const error = await client
      .completeChat("triage", [...USER_MESSAGE])
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toMatch(/Gemini down/);
  });

  it("spends no budget when a provider throws synchronously, before any call", async () => {
    const syncThrower = {
      completeChat: (): Promise<string> => {
        throw new Error("sync refusal: non-free model");
      },
      completeJson: async (): Promise<never> => {
        throw new Error("sync refusal: non-free model");
      },
      name: "sync-thrower",
    };
    const client = new RoutedModelClient({
      budget: 1,
      models: MODELS,
      primary: syncThrower,
    });

    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(/sync refusal/);
    expect(client.callsUsed).toBe(0);
    // A second attempt is still possible: no budget was spent.
    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(/sync refusal/);
    expect(client.callsUsed).toBe(0);
  });

  it("resets the count only when a new cycle client is created", async () => {
    const { client, primary } = makeClient({ budget: 1 });
    await client.completeChat("triage", [...USER_MESSAGE]);
    await expect(
      client.completeChat("triage", [...USER_MESSAGE]),
    ).rejects.toThrow(BudgetExhaustedError);

    const fresh = new RoutedModelClient({
      budget: 1,
      models: MODELS,
      primary,
    });
    expect(fresh.callsUsed).toBe(0);
    await expect(
      fresh.completeChat("triage", [...USER_MESSAGE]),
    ).resolves.toBe("primary reply");
  });

  it("defaults to a small per-cycle budget when none is given", () => {
    expect(DEFAULT_MODEL_CALL_BUDGET).toBe(50);
    const { client } = makeClient();
    expect(client.budget).toBe(50);
  });
});
