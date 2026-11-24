import { describe, expect, it } from "vitest";

import { loadConfig, requireKey } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when no variables are set", () => {
    const config = loadConfig({});

    expect(config.dataDir).toBe("./data");
    expect(config.approvalGate).toBe(true);
    expect(config.dryRun).toBe(false);
    expect(config.reviewPassThreshold).toBe(0.7);
    expect(config.delphiApiKey).toBeUndefined();
    expect(config.delphiReadApiKey).toBeUndefined();
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.openrouterApiKey).toBeUndefined();
    expect(config.tavilyApiKey).toBeUndefined();
    expect(config.maxMarketsPerCycle).toBeUndefined();
    expect(config.maxSubmissionsPerCycle).toBeUndefined();
    expect(config.modelCallBudget).toBeUndefined();
    expect(config.cycleTimeBudgetMinutes).toBeUndefined();
    expect(config.tavilySearchEndpoint).toBe("https://api.tavily.com/search");
    expect(config.maxSearchesPerMarket).toBeUndefined();
    expect(config.maxPagesPerMarket).toBeUndefined();
    expect(config.maxModelCallsPerMarket).toBeUndefined();
    expect(config.notesCharBudget).toBeUndefined();
    expect(config.geminiFastModel).toBe("gemini-3.5-flash-lite");
    expect(config.geminiStrongModel).toBe("gemini-3.8-flash");
    expect(config.openrouterFastModel).toBe(
      "nvidia/nemotron-3.5-lightning:free",
    );
    expect(config.openrouterStrongModel).toBe(
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
  });

  it("reads API keys and limits from the environment", () => {
    const config = loadConfig({
      DELPHI_API_ACCESS_KEY: "delphi-key",
      DELPHI_API_READ_KEY: "delphi-read-key",
      GEMINI_API_KEY: "gemini-key",
      GEMINI_FAST_MODEL: "gemini-fast-custom",
      GEMINI_STRONG_MODEL: "gemini-strong-custom",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_FAST_MODEL: "custom/fast:free",
      OPENROUTER_STRONG_MODEL: "custom/strong:free",
      TAVILY_API_KEY: "tavily-key",
      TAVILY_SEARCH_ENDPOINT: "https://search.example.invalid/search",
      VGEN19_APPROVAL_GATE: "false",
      VGEN19_DATA_DIR: "./custom-data",
      VGEN19_DRY_RUN: "true",
      VGEN19_MAX_MARKETS_PER_CYCLE: "5",
      VGEN19_MAX_MODEL_CALLS_PER_MARKET: "4",
      VGEN19_MAX_PAGES_PER_MARKET: "3",
      VGEN19_MAX_SEARCHES_PER_MARKET: "2",
      VGEN19_NOTES_CHAR_BUDGET: "4000",
      VGEN19_MAX_SUBMISSIONS_PER_CYCLE: "9",
      VGEN19_MODEL_CALL_BUDGET: "40",
      VGEN19_CYCLE_TIME_BUDGET_MINUTES: "30",
      VGEN19_REVIEW_PASS_THRESHOLD: "0.85",
    });

    expect(config.delphiApiKey).toBe("delphi-key");
    expect(config.delphiReadApiKey).toBe("delphi-read-key");
    expect(config.geminiApiKey).toBe("gemini-key");
    expect(config.geminiFastModel).toBe("gemini-fast-custom");
    expect(config.geminiStrongModel).toBe("gemini-strong-custom");
    expect(config.openrouterApiKey).toBe("openrouter-key");
    expect(config.openrouterFastModel).toBe("custom/fast:free");
    expect(config.openrouterStrongModel).toBe("custom/strong:free");
    expect(config.tavilyApiKey).toBe("tavily-key");
    expect(config.tavilySearchEndpoint).toBe(
      "https://search.example.invalid/search",
    );
    expect(config.maxSearchesPerMarket).toBe(2);
    expect(config.maxPagesPerMarket).toBe(3);
    expect(config.maxModelCallsPerMarket).toBe(4);
    expect(config.notesCharBudget).toBe(4000);
    expect(config.dataDir).toBe("./custom-data");
    expect(config.approvalGate).toBe(false);
    expect(config.dryRun).toBe(true);
    expect(config.maxMarketsPerCycle).toBe(5);
    expect(config.maxSubmissionsPerCycle).toBe(9);
    expect(config.modelCallBudget).toBe(40);
    expect(config.cycleTimeBudgetMinutes).toBe(30);
    expect(config.reviewPassThreshold).toBe(0.85);
  });

  it("accepts DELPHI_API_KEY as an alias for the Delphi key", () => {
    const config = loadConfig({ DELPHI_API_KEY: "delphi-key-alias" });

    expect(config.delphiApiKey).toBe("delphi-key-alias");
  });

  it("prefers DELPHI_API_ACCESS_KEY over the DELPHI_API_KEY alias", () => {
    const config = loadConfig({
      DELPHI_API_ACCESS_KEY: "delphi-key-primary",
      DELPHI_API_KEY: "delphi-key-alias",
    });

    expect(config.delphiApiKey).toBe("delphi-key-primary");
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({
      DELPHI_API_ACCESS_KEY: "   ",
      DELPHI_API_READ_KEY: "  ",
      VGEN19_DATA_DIR: "",
    });

    expect(config.delphiApiKey).toBeUndefined();
    expect(config.delphiReadApiKey).toBeUndefined();
    expect(config.dataDir).toBe("./data");
  });

  it("rejects a non-boolean approval gate value with the variable name", () => {
    expect(() => loadConfig({ VGEN19_APPROVAL_GATE: "yes" })).toThrow(
      /VGEN19_APPROVAL_GATE/,
    );
  });

  it("rejects a non-numeric limit with the variable name", () => {
    expect(() =>
      loadConfig({ VGEN19_MAX_MARKETS_PER_CYCLE: "many" }),
    ).toThrow(/VGEN19_MAX_MARKETS_PER_CYCLE/);
  });

  it("rejects a non-positive limit with the variable name", () => {
    expect(() => loadConfig({ VGEN19_MODEL_CALL_BUDGET: "0" })).toThrow(
      /VGEN19_MODEL_CALL_BUDGET/,
    );
  });

  it("rejects a non-positive time budget with the variable name", () => {
    expect(() =>
      loadConfig({ VGEN19_CYCLE_TIME_BUDGET_MINUTES: "0" }),
    ).toThrow(/VGEN19_CYCLE_TIME_BUDGET_MINUTES/);
  });

  it("rejects a non-positive research limit with the variable name", () => {
    expect(() =>
      loadConfig({ VGEN19_MAX_PAGES_PER_MARKET: "0" }),
    ).toThrow(/VGEN19_MAX_PAGES_PER_MARKET/);
  });

  it("rejects a review pass threshold outside (0, 1] with the variable name", () => {
    expect(() =>
      loadConfig({ VGEN19_REVIEW_PASS_THRESHOLD: "0" }),
    ).toThrow(/VGEN19_REVIEW_PASS_THRESHOLD/);
    expect(() =>
      loadConfig({ VGEN19_REVIEW_PASS_THRESHOLD: "1.5" }),
    ).toThrow(/VGEN19_REVIEW_PASS_THRESHOLD/);
    expect(() =>
      loadConfig({ VGEN19_REVIEW_PASS_THRESHOLD: "high" }),
    ).toThrow(/VGEN19_REVIEW_PASS_THRESHOLD/);
  });
});

describe("requireKey", () => {
  it("returns the key when present", () => {
    expect(requireKey("some-key", "GEMINI_API_KEY")).toBe("some-key");
  });

  it("fails closed with the variable name when the key is missing", () => {
    expect(() => requireKey(undefined, "DELPHI_API_KEY")).toThrow(
      /DELPHI_API_KEY/,
    );
  });

  it("fails closed when the key is blank", () => {
    expect(() => requireKey("  ", "TAVILY_API_KEY")).toThrow(
      /TAVILY_API_KEY/,
    );
  });
});
