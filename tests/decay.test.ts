import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeDecayScore } from "../db.js";
import { parseConfig, DEFAULTS } from "../config.js";

describe("computeDecayScore", () => {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  const fixedNow = Date.now();

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  const defaultConfig = {
    enabled: true,
    halfLifeDays: 30,
    activeWeight: 0.1,
  };

  it("returns vectorScore unchanged when decay is disabled", () => {
    const disabledConfig = { ...defaultConfig, enabled: false };
    const result = computeDecayScore(0.8, fixedNow - 60 * MS_PER_DAY, 5, disabledConfig);
    expect(result).toBe(0.8);
  });

  it("new memory (0 days) has score = vectorScore * 1.0 * activeBoost", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow; // 0 days ago
    const activeCount = 0;

    const result = computeDecayScore(vectorScore, createdAt, activeCount, defaultConfig);

    // timeDecay = 2^(-0/30) = 1.0
    // activeBoost = 1 + 0.1 * ln(1) = 1 + 0.1 * 0 = 1.0
    // expected = 0.8 * 1.0 * 1.0 = 0.8
    expect(result).toBeCloseTo(0.8, 6);
  });

  it("30-day memory has score = vectorScore * 0.5 * activeBoost", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow - 30 * MS_PER_DAY; // 30 days ago
    const activeCount = 0;

    const result = computeDecayScore(vectorScore, createdAt, activeCount, defaultConfig);

    // timeDecay = 2^(-30/30) = 2^(-1) = 0.5
    // activeBoost = 1 + 0.1 * ln(1) = 1.0
    // expected = 0.8 * 0.5 * 1.0 = 0.4
    expect(result).toBeCloseTo(0.4, 6);
  });

  it("60-day memory has score = vectorScore * 0.25 * activeBoost", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow - 60 * MS_PER_DAY; // 60 days ago
    const activeCount = 0;

    const result = computeDecayScore(vectorScore, createdAt, activeCount, defaultConfig);

    // timeDecay = 2^(-60/30) = 2^(-2) = 0.25
    // activeBoost = 1 + 0.1 * ln(1) = 1.0
    // expected = 0.8 * 0.25 * 1.0 = 0.2
    expect(result).toBeCloseTo(0.2, 6);
  });

  it("high active count provides boost over low active count", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow - 30 * MS_PER_DAY;

    const lowActiveScore = computeDecayScore(vectorScore, createdAt, 0, defaultConfig);
    const highActiveScore = computeDecayScore(vectorScore, createdAt, 10, defaultConfig);

    // lowActive: 0.8 * 0.5 * 1.0 = 0.4
    // highActive: 0.8 * 0.5 * (1 + 0.1 * ln(11)) ≈ 0.8 * 0.5 * 1.2398 ≈ 0.496
    expect(highActiveScore).toBeGreaterThan(lowActiveScore);

    // Verify the active boost calculation
    const expectedLowActive = 0.8 * 0.5 * (1 + 0.1 * Math.log(1));
    const expectedHighActive = 0.8 * 0.5 * (1 + 0.1 * Math.log(11));
    expect(lowActiveScore).toBeCloseTo(expectedLowActive, 6);
    expect(highActiveScore).toBeCloseTo(expectedHighActive, 6);
  });

  it("active boost formula is logarithmic (diminishing returns)", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow; // fresh memory

    const count1 = computeDecayScore(vectorScore, createdAt, 1, defaultConfig);
    const count10 = computeDecayScore(vectorScore, createdAt, 10, defaultConfig);
    const count100 = computeDecayScore(vectorScore, createdAt, 100, defaultConfig);

    // Boost increments should diminish
    const boost1to10 = count10 - count1;
    const boost10to100 = count100 - count10;

    expect(boost1to10).toBeGreaterThan(0);
    expect(boost10to100).toBeGreaterThan(0);
    expect(boost10to100).toBeLessThan(boost1to10 * 2); // Logarithmic growth
  });

  it("custom halfLifeDays affects decay rate", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow - 15 * MS_PER_DAY; // 15 days ago

    const config15Days = { ...defaultConfig, halfLifeDays: 15 };
    const config30Days = { ...defaultConfig, halfLifeDays: 30 };

    const result15 = computeDecayScore(vectorScore, createdAt, 0, config15Days);
    const result30 = computeDecayScore(vectorScore, createdAt, 0, config30Days);

    // With 15-day half-life, 15 days = 0.5 decay
    // With 30-day half-life, 15 days = 2^(-0.5) ≈ 0.707 decay
    expect(result15).toBeCloseTo(0.8 * 0.5, 6);
    expect(result30).toBeCloseTo(0.8 * Math.pow(2, -0.5), 6);
    expect(result30).toBeGreaterThan(result15);
  });

  it("custom activeWeight affects boost magnitude", () => {
    const vectorScore = 0.8;
    const createdAt = fixedNow;
    const activeCount = 10;

    const lowWeight = { ...defaultConfig, activeWeight: 0.05 };
    const highWeight = { ...defaultConfig, activeWeight: 0.2 };

    const resultLow = computeDecayScore(vectorScore, createdAt, activeCount, lowWeight);
    const resultHigh = computeDecayScore(vectorScore, createdAt, activeCount, highWeight);

    expect(resultHigh).toBeGreaterThan(resultLow);

    // Verify calculations
    const expectedLow = 0.8 * 1.0 * (1 + 0.05 * Math.log(11));
    const expectedHigh = 0.8 * 1.0 * (1 + 0.2 * Math.log(11));
    expect(resultLow).toBeCloseTo(expectedLow, 6);
    expect(resultHigh).toBeCloseTo(expectedHigh, 6);
  });
});

describe("decay config in parseConfig", () => {
  const baseConfig = {
    embedding: { apiKey: "k" },
    llm: { apiKey: "k" },
  };

  it("accepts valid decay config", () => {
    const config = parseConfig({
      ...baseConfig,
      decay: {
        enabled: true,
        halfLifeDays: 15,
        activeWeight: 0.2,
      },
    });
    expect(config.decay?.enabled).toBe(true);
    expect(config.decay?.halfLifeDays).toBe(15);
    expect(config.decay?.activeWeight).toBe(0.2);
  });

  it("accepts partial decay config", () => {
    const config = parseConfig({
      ...baseConfig,
      decay: { enabled: true },
    });
    expect(config.decay?.enabled).toBe(true);
    expect(config.decay?.halfLifeDays).toBeUndefined();
  });

  it("throws when decay.halfLifeDays is out of range (below min)", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { halfLifeDays: 0 },
      }),
    ).toThrow("decay.halfLifeDays must be a number between 1 and 365");
  });

  it("throws when decay.halfLifeDays is out of range (above max)", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { halfLifeDays: 400 },
      }),
    ).toThrow("decay.halfLifeDays must be a number between 1 and 365");
  });

  it("throws when decay.activeWeight is out of range (below min)", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { activeWeight: -0.1 },
      }),
    ).toThrow("decay.activeWeight must be a number between 0 and 1");
  });

  it("throws when decay.activeWeight is out of range (above max)", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { activeWeight: 1.5 },
      }),
    ).toThrow("decay.activeWeight must be a number between 0 and 1");
  });

  it("throws when decay.halfLifeDays is a string", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { halfLifeDays: "30" as unknown as number },
      }),
    ).toThrow("decay.halfLifeDays must be a number, got string");
  });

  it("throws when decay.activeWeight is null", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { activeWeight: null as unknown as number },
      }),
    ).toThrow("decay.activeWeight must be a number, got null");
  });

  it("throws when decay.halfLifeDays is NaN", () => {
    expect(() =>
      parseConfig({
        ...baseConfig,
        decay: { halfLifeDays: NaN },
      }),
    ).toThrow("decay.halfLifeDays must be a number, got NaN");
  });

  it("accepts boundary values", () => {
    const config = parseConfig({
      ...baseConfig,
      decay: {
        halfLifeDays: 1,
        activeWeight: 0,
      },
    });
    expect(config.decay?.halfLifeDays).toBe(1);
    expect(config.decay?.activeWeight).toBe(0);

    const config2 = parseConfig({
      ...baseConfig,
      decay: {
        halfLifeDays: 365,
        activeWeight: 1,
      },
    });
    expect(config2.decay?.halfLifeDays).toBe(365);
    expect(config2.decay?.activeWeight).toBe(1);
  });
});

describe("DEFAULTS.decay", () => {
  it("has expected default values", () => {
    expect(DEFAULTS.decay.enabled).toBe(false);
    expect(DEFAULTS.decay.halfLifeDays).toBe(30);
    expect(DEFAULTS.decay.activeWeight).toBe(0.1);
  });
});
