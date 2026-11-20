import { describe, expect, it } from "vitest";

import { FakeModelProvider } from "../../src/llm/fake.js";

describe("FakeModelProvider", () => {
  it("returns scripted text for chat completion", async () => {
    const fake = new FakeModelProvider({
      script: [{ text: "Hello, miner." }],
    });

    const reply = await fake.completeChat([
      { content: "Hi", role: "user" },
    ]);

    expect(reply).toBe("Hello, miner.");
  });

  it("returns scripted responses in order, then the default text", async () => {
    const fake = new FakeModelProvider({
      defaultText: "fallback reply",
      script: [{ text: "first" }, { text: "second" }],
    });

    expect(
      await fake.completeChat([{ content: "1", role: "user" }]),
    ).toBe("first");
    expect(
      await fake.completeChat([{ content: "2", role: "user" }]),
    ).toBe("second");
    expect(
      await fake.completeChat([{ content: "3", role: "user" }]),
    ).toBe("fallback reply");
  });

  it("throws a scripted failure", async () => {
    const fake = new FakeModelProvider({
      script: [{ error: new Error("provider down") }],
    });

    await expect(
      fake.completeChat([{ content: "Hi", role: "user" }]),
    ).rejects.toThrow("provider down");
  });

  it("records every call with its messages and model", async () => {
    const fake = new FakeModelProvider({
      script: [{ text: "ok" }, { error: new Error("boom") }],
    });

    await fake.completeChat([{ content: "one", role: "user" }], {
      model: "fast-model",
    });
    await expect(
      fake.completeChat([{ content: "two", role: "user" }], {
        model: "strong-model",
      }),
    ).rejects.toThrow("boom");

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.messages).toEqual([
      { content: "one", role: "user" },
    ]);
    expect(fake.calls[0]?.model).toBe("fast-model");
    expect(fake.calls[1]?.model).toBe("strong-model");
  });

  it("supports structured JSON output through the shared validator", async () => {
    const fake = new FakeModelProvider({
      script: [{ text: '{"verdict":"yes","score":8}' }],
    });

    const parsed = await fake.completeJson<{ score: number; verdict: string }>(
      [{ content: "Judge this draft.", role: "user" }],
      {
        properties: {
          score: { type: "number" },
          verdict: { enum: ["yes", "no"], type: "string" },
        },
        required: ["score", "verdict"],
        type: "object",
      },
    );

    expect(parsed).toEqual({ score: 8, verdict: "yes" });
    expect(fake.calls[0]?.jsonMode).toBe(true);
  });

  it("answers per call kind through replyFor once the script runs out", async () => {
    const fake = new FakeModelProvider({
      defaultText: "default",
      replyFor: (messages) =>
        messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("judge"),
        )
          ? "judged"
          : undefined,
      script: [{ text: "first" }],
    });

    expect(
      await fake.completeChat([{ content: "1", role: "user" }]),
    ).toBe("first");
    expect(
      await fake.completeChat([
        { content: "You judge evidence drafts.", role: "system" },
        { content: "Judge this.", role: "user" },
      ]),
    ).toBe("judged");
    expect(
      await fake.completeChat([{ content: "other", role: "user" }]),
    ).toBe("default");
  });

  it("rejects invalid JSON from structured output instead of returning it", async () => {
    const fake = new FakeModelProvider({
      script: [{ text: "not json" }],
    });

    await expect(
      fake.completeJson(
        [{ content: "Judge this draft.", role: "user" }],
        {
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
          type: "object",
        },
      ),
    ).rejects.toThrow(/not valid JSON/);
  });
});
