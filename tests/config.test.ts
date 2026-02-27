import { describe, it, expect } from "vitest";
import { parseConfig, DEFAULTS, vectorDimsForModel } from "../config.js";

describe("parseConfig", () => {
  it("throws when embedding.apiKey is missing", () => {
    expect(() => parseConfig({})).toThrow("embedding.apiKey is required");
  });

  it("throws when embedding.apiKey is empty string", () => {
    expect(() =>
      parseConfig({ embedding: { apiKey: "" }, llm: { apiKey: "k" } }),
    ).toThrow("embedding.apiKey is required");
  });

  it("throws when llm.apiKey is missing", () => {
    expect(() => parseConfig({ embedding: { apiKey: "k" } })).toThrow(
      "llm.apiKey is required",
    );
  });

  it("throws when llm.apiKey is empty string", () => {
    expect(() =>
      parseConfig({ embedding: { apiKey: "k" }, llm: { apiKey: "" } }),
    ).toThrow("llm.apiKey is required");
  });

  it("returns config with valid keys", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "embed-key" },
      llm: { apiKey: "llm-key" },
    });
    expect(cfg.embedding.apiKey).toBe("embed-key");
    expect(cfg.llm.apiKey).toBe("llm-key");
  });

  it("preserves optional values", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k", model: "custom" },
      llm: { apiKey: "k" },
      recallLimit: 10,
      autoRecall: false,
    });
    expect(cfg.embedding.model).toBe("custom");
    expect(cfg.recallLimit).toBe(10);
    expect(cfg.autoRecall).toBe(false);
  });

  // --- Range validation (P2 fix) ---
  it("throws when recallLimit is out of range", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallLimit: 0,
      }),
    ).toThrow("recallLimit must be a number between 1 and 100");
  });

  it("throws when recallLimit exceeds maximum", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallLimit: 200,
      }),
    ).toThrow("recallLimit must be a number between 1 and 100");
  });

  it("throws when recallMinScore is out of range", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallMinScore: -0.1,
      }),
    ).toThrow("recallMinScore must be a number between 0 and 1");
  });

  it("throws when recallMinScore exceeds 1", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallMinScore: 1.5,
      }),
    ).toThrow("recallMinScore must be a number between 0 and 1");
  });

  it("throws when extractMinMessages is out of range", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        extractMinMessages: 0,
      }),
    ).toThrow("extractMinMessages must be a number between 1 and 100");
  });

  it("throws when extractMaxChars is below minimum", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        extractMaxChars: 50,
      }),
    ).toThrow("extractMaxChars must be a number between 100 and 100000");
  });

  it("throws when extractMaxChars exceeds maximum", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        extractMaxChars: 200000,
      }),
    ).toThrow("extractMaxChars must be a number between 100 and 100000");
  });

  it("throws when recallMinScore is NaN", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallMinScore: NaN,
      }),
    ).toThrow("recallMinScore must be a number, got NaN");
  });

  // --- Pre-cast type validation (P2 fix) ---
  it("throws when recallMinScore is a string", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallMinScore: "foo" as unknown,
      }),
    ).toThrow("recallMinScore must be a number, got string");
  });

  it("throws when recallLimit is a boolean", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallLimit: true as unknown,
      }),
    ).toThrow("recallLimit must be a number, got boolean");
  });

  it("throws when extractMaxChars is null", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        extractMaxChars: null as unknown,
      }),
    ).toThrow("extractMaxChars must be a number, got null");
  });

  it("throws when recallLimit is Infinity", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        recallLimit: Infinity,
      }),
    ).toThrow("recallLimit must be a number between 1 and 100");
  });

  it("accepts valid range boundary values", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      recallLimit: 1,
      recallMinScore: 0,
      extractMinMessages: 100,
      extractMaxChars: 100000,
    });
    expect(cfg.recallLimit).toBe(1);
    expect(cfg.recallMinScore).toBe(0);
    expect(cfg.extractMinMessages).toBe(100);
    expect(cfg.extractMaxChars).toBe(100000);
  });
});

describe("vectorDimsForModel", () => {
  it("returns 1536 for text-embedding-3-small", () => {
    expect(vectorDimsForModel("text-embedding-3-small")).toBe(1536);
  });

  it("returns 3072 for text-embedding-3-large", () => {
    expect(vectorDimsForModel("text-embedding-3-large")).toBe(3072);
  });

  it("returns 1536 as fallback for unknown model", () => {
    expect(vectorDimsForModel("nomic-embed-text")).toBe(1536);
  });
});

describe("nested numeric field pre-cast validation", () => {
  const base = { embedding: { apiKey: "k" }, llm: { apiKey: "k" } };

  it("rejects string qmdProjection.intervalMs", () => {
    expect(() =>
      parseConfig({ ...base, qmdProjection: { intervalMs: "fast" } }),
    ).toThrow("qmdProjection.intervalMs must be a number");
  });

  it("rejects null bootstrap.patternPromotionThreshold", () => {
    expect(() =>
      parseConfig({ ...base, bootstrap: { patternPromotionThreshold: null } }),
    ).toThrow("bootstrap.patternPromotionThreshold must be a number, got null");
  });

  it("rejects NaN bootstrap.minConfidence", () => {
    expect(() =>
      parseConfig({ ...base, bootstrap: { minConfidence: NaN } }),
    ).toThrow("bootstrap.minConfidence must be a number, got NaN");
  });

  it("rejects out-of-range qmdProjection.intervalMs", () => {
    expect(() =>
      parseConfig({ ...base, qmdProjection: { intervalMs: 100 } }),
    ).toThrow("qmdProjection.intervalMs must be a number between");
  });

  it("rejects out-of-range bootstrap.patternPromotionThreshold", () => {
    expect(() =>
      parseConfig({ ...base, bootstrap: { patternPromotionThreshold: 0 } }),
    ).toThrow("bootstrap.patternPromotionThreshold must be a number between");
  });

  it("accepts valid nested numeric values", () => {
    const cfg = parseConfig({
      ...base,
      qmdProjection: { intervalMs: 3_600_000 },
      bootstrap: { patternPromotionThreshold: 10, minConfidence: 0.8 },
    });
    expect(cfg.qmdProjection?.intervalMs).toBe(3_600_000);
    expect(cfg.bootstrap?.patternPromotionThreshold).toBe(10);
    expect(cfg.bootstrap?.minConfidence).toBe(0.8);
  });
});

describe("DEFAULTS", () => {
  it("has expected values", () => {
    expect(DEFAULTS.embeddingModel).toBe("text-embedding-3-small");
    expect(DEFAULTS.llmModel).toBe("gpt-4o-mini");
    expect(DEFAULTS.autoCapture).toBe(true);
    expect(DEFAULTS.autoRecall).toBe(true);
    expect(DEFAULTS.recallLimit).toBe(5);
    expect(DEFAULTS.recallMinScore).toBe(0.3);
    expect(DEFAULTS.extractMinMessages).toBe(4);
    expect(DEFAULTS.extractMaxChars).toBe(8000);
  });
});
