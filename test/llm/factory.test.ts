import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createRoutedClient } from "../../src/llm/client.js";
import { FakeModelProvider } from "../../src/llm/fake.js";
import type { FetchFn, FetchResponse } from "../../src/llm/http.js";

function jsonResponse(body: unknown, status = 200): FetchResponse {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("createRoutedClient", () => {
  it("fails closed naming GEMINI_API_KEY when no default key is set", () => {
    const config = loadConfig({});

    expect(() => createRoutedClient(config)).toThrow(/GEMINI_API_KEY/);
  });

  it("builds a primary-only client when only the Gemini key is set", async () => {
    const config = loadConfig({ GEMINI_API_KEY: "gemini-key" });
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "from gemini" }] } }],
      }),
    );

    const client = createRoutedClient(config, { fetchFn });
    const reply = await client.completeChat("triage", [
      { content: "Hi", role: "user" },
    ]);

    expect(reply).toBe("from gemini");
    const [url] = fetchFn.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-3.5-flash-lite");
  });

  it("wires the configured model IDs into the providers", async () => {
    const config = loadConfig({
      GEMINI_API_KEY: "gemini-key",
      GEMINI_STRONG_MODEL: "gemini-3.8-flash",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_FAST_MODEL: "nvidia/nemotron-3.5-lightning:free",
    });
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "strong reply" }] } }],
      }),
    );

    const client = createRoutedClient(config, { fetchFn });
    await client.completeChat("drafting", [
      { content: "Draft.", role: "user" },
    ]);

    const [url] = fetchFn.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("/models/gemini-3.8-flash:generateContent");
  });

  it("falls back to OpenRouter through the live providers when Gemini fails", async () => {
    const config = loadConfig({
      GEMINI_API_KEY: "gemini-key",
      OPENROUTER_API_KEY: "openrouter-key",
    });
    const fetchFn = vi.fn<FetchFn>(async (url) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return jsonResponse({ error: { message: "Quota exceeded." } }, 429);
      }
      return jsonResponse({
        choices: [{ message: { content: "from openrouter", role: "assistant" } }],
      });
    });

    const client = createRoutedClient(config, { fetchFn });
    const reply = await client.completeChat("triage", [
      { content: "Hi", role: "user" },
    ]);

    expect(reply).toBe("from openrouter");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [fallbackUrl] = fetchFn.mock.calls[1] as [string, { body: string }];
    expect(fallbackUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    const [, fallbackInit] = fetchFn.mock.calls[1] as [
      string,
      { body: string },
    ];
    const body = JSON.parse(fallbackInit.body) as { model: string };
    expect(body.model).toBe("nvidia/nemotron-3.5-lightning:free");
  });

  it("builds an OpenRouter-primary client when only the OpenRouter key is set", async () => {
    const config = loadConfig({ OPENROUTER_API_KEY: "openrouter-key" });
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "from openrouter", role: "assistant" } }],
      }),
    );

    const client = createRoutedClient(config, { fetchFn });
    const reply = await client.completeChat("triage", [
      { content: "Hi", role: "user" },
    ]);

    expect(reply).toBe("from openrouter");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe("nvidia/nemotron-3.5-lightning:free");
  });

  it("uses the OpenRouter strong model for drafting when OpenRouter is primary", async () => {
    const config = loadConfig({ OPENROUTER_API_KEY: "openrouter-key" });
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "drafted", role: "assistant" } }],
      }),
    );

    const client = createRoutedClient(config, { fetchFn });
    await client.completeChat("drafting", [
      { content: "Draft.", role: "user" },
    ]);

    const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  it("applies the configured budget, defaulting to 50", () => {
    const withBudget = createRoutedClient(
      loadConfig({ GEMINI_API_KEY: "k", VGEN19_MODEL_CALL_BUDGET: "12" }),
    );
    expect(withBudget.budget).toBe(12);

    const withoutBudget = createRoutedClient(
      loadConfig({ GEMINI_API_KEY: "k" }),
    );
    expect(withoutBudget.budget).toBe(50);
  });

  it("accepts injected providers so later tickets can test with fakes", async () => {
    const config = loadConfig({});
    const fake = new FakeModelProvider({ defaultText: "fake reply" });

    const client = createRoutedClient(config, {
      providers: { primary: fake },
    });

    await expect(
      client.completeChat("triage", [{ content: "Hi", role: "user" }]),
    ).resolves.toBe("fake reply");
    expect(fake.calls[0]?.model).toBe("gemini-3.5-flash-lite");
  });
});
