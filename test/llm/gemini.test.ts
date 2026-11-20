import { describe, expect, it, vi } from "vitest";

import { GeminiProvider } from "../../src/llm/gemini.js";
import type { FetchFn, FetchResponse } from "../../src/llm/http.js";
import { ProviderError } from "../../src/llm/types.js";

function jsonResponse(body: unknown, status = 200): FetchResponse {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function geminiReply(text: string): FetchResponse {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text }], role: "model" } }],
  });
}

describe("GeminiProvider", () => {
  it("posts to the generateContent endpoint with the API key header", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(geminiReply("Hi."));
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
      fetchFn,
    });

    const reply = await provider.completeChat([
      { content: "Hello", role: "user" },
    ]);

    expect(reply).toBe("Hi.");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, { body: string; headers: Record<string, string>; method: string }];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body) as {
      contents: Array<{ parts: Array<{ text: string }>; role: string }>;
    };
    expect(body.contents).toEqual([
      { parts: [{ text: "Hello" }], role: "user" },
    ]);
  });

  it("maps system messages to systemInstruction and assistant to model", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(geminiReply("ok"));
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
      fetchFn,
    });

    await provider.completeChat([
      { content: "You mine evidence.", role: "system" },
      { content: "Find facts.", role: "user" },
      { content: "Found one.", role: "assistant" },
      { content: "More.", role: "user" },
    ]);

    const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      contents: Array<{ role: string }>;
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "You mine evidence." }],
    });
    expect(body.contents.map((entry) => entry.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  it("uses the model from options when given", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(geminiReply("ok"));
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
      fetchFn,
    });

    await provider.completeChat([{ content: "Hi", role: "user" }], {
      model: "gemini-3.8-flash",
    });

    const [url] = fetchFn.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("/models/gemini-3.8-flash:generateContent");
  });

  it("requests JSON output in JSON mode", async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValue(geminiReply('{"verdict":"yes"}'));
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
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
      generationConfig: { responseMimeType?: string };
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("throws a clear error on a non-2xx status (including rate limits)", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(
      jsonResponse({ error: { message: "Quota exceeded." } }, 429),
    );
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
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
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(/Gemini request failed/);
  });

  it("throws a clear error when the reply carries no text", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(jsonResponse({}));
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
      fetchFn,
    });

    await expect(
      provider.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow(/no text/);
  });

  it("sends an abort signal so a hung call times out", async () => {
    const fetchFn = vi.fn<FetchFn>().mockResolvedValue(geminiReply("ok"));
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
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
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
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
    const provider = new GeminiProvider({
      apiKey: "test-key",
      defaultModel: "gemini-3.5-flash-lite",
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
