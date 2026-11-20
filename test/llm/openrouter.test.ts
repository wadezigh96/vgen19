import { describe, expect, it, vi } from "vitest";

import type { FetchFn, FetchResponse } from "../../src/llm/http.js";
import { OpenRouterProvider } from "../../src/llm/openrouter.js";
import { ProviderError } from "../../src/llm/types.js";

function jsonResponse(body: unknown, status = 200): FetchResponse {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function chatReply(text: string): FetchResponse {
  return jsonResponse({
    choices: [{ message: { content: text, role: "assistant" } }],
  });
}

const FAST_MODEL = "nvidia/nemotron-3.5-lightning:free";

describe("OpenRouterProvider", () => {
  it("posts to the chat completions endpoint with a Bearer key", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(chatReply("Hi."));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    const reply = await provider.completeChat([
      { content: "Hello", role: "user" },
    ]);

    expect(reply).toBe("Hi.");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string>; method: string },
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body) as {
      messages: Array<{ content: string; role: string }>;
      model: string;
    };
    expect(body.model).toBe(FAST_MODEL);
    expect(body.messages).toEqual([{ content: "Hello", role: "user" }]);
  });

  it("uses the model from options when given", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(chatReply("ok"));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    await provider.completeChat([{ content: "Hi", role: "user" }], {
      model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    });

    const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as { model: string };
    expect(body.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  it("requests JSON output in JSON mode", async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValue(chatReply('{"verdict":"yes"}'));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    const parsed = await provider.completeJson<{ verdict: string }>(
      [{ content: "Judge.", role: "user" }],
      {
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
        type: "object",
      },
    );

    expect(parsed).toEqual({ verdict: "yes" });
    const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      response_format?: { type: string };
    };
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("refuses a paid model ID at construction, before any call is made", () => {
    expect(
      () =>
        new OpenRouterProvider({
          apiKey: "test-key",
          defaultModel: "openai/gpt-4o-mini",
        }),
    ).toThrow(/free/);
  });

  it("refuses a paid model ID passed per call", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(chatReply("ok"));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }], {
        model: "anthropic/claude-sonnet-4.6",
      }),
    ).rejects.toThrow(/free/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts the openrouter/free router model", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(chatReply("ok"));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: "openrouter/free",
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).resolves.toBe("ok");
  });

  it("throws a clear error on a non-2xx status (including rate limits)", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ error: { message: "Rate limited." } }, 429),
    );
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(ProviderError);
    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(/429/);
  });

  it("throws a clear error when the network fails", async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockRejectedValue(new Error("fetch failed"));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(/OpenRouter request failed/);
  });

  it("throws a clear error when the reply carries no text", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: null } }] }),
    );
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(/no text/);
  });

  it("sends an abort signal so a hung call times out", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(chatReply("ok"));
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    await provider.completeChat([{ content: "Hi", role: "user" }]);

    const [, init] = fetchFn.mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });

  it("fails with a ProviderError when the call times out", async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<FetchResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("The operation was aborted"));
        });
      });
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
      timeoutMs: 10,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(ProviderError);
  });

  it("turns invalid JSON in a 200 reply into a ProviderError, not a raw SyntaxError", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue({
      json: async (): Promise<unknown> => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    } satisfies FetchResponse);
    const provider = new OpenRouterProvider({
      apiKey: "test-key",
      defaultModel: FAST_MODEL,
      fetchFn,
    });

    const error = await provider
      .completeChat([{ content: "Hi", role: "user" }])
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(SyntaxError);
  });
});
