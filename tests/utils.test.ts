import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertCategory,
  assertUuid,
  computeDecayScore,
  VALID_CATEGORIES,
} from "../utils.js";

describe("assertCategory", () => {
  it("accepts all valid categories", () => {
    for (const cat of VALID_CATEGORIES) {
      expect(() => assertCategory(cat)).not.toThrow();
    }
  });

  it("rejects invalid category", () => {
    expect(() => assertCategory("invalid")).toThrow("Invalid memory category");
  });

  it("rejects empty string", () => {
    expect(() => assertCategory("")).toThrow("Invalid memory category");
  });
});

describe("assertUuid", () => {
  it("accepts valid UUID", () => {
    expect(() =>
      assertUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).not.toThrow();
  });

  it("accepts uppercase UUID", () => {
    expect(() =>
      assertUuid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"),
    ).not.toThrow();
  });

  it("rejects non-UUID string", () => {
    expect(() => assertUuid("not-a-uuid")).toThrow("Invalid UUID");
  });

  it("rejects empty string", () => {
    expect(() => assertUuid("")).toThrow("Invalid UUID");
  });

  it("rejects UUID with extra characters", () => {
    expect(() =>
      assertUuid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-extra"),
    ).toThrow("Invalid UUID");
  });
});

describe("computeDecayScore (from utils)", () => {
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

  it("returns vectorScore when decay disabled", () => {
    const result = computeDecayScore(
      0.8,
      fixedNow - 60 * MS_PER_DAY,
      5,
      { ...defaultConfig, enabled: false },
    );
    expect(result).toBe(0.8);
  });

  it("fresh memory has full score", () => {
    const result = computeDecayScore(0.8, fixedNow, 0, defaultConfig);
    expect(result).toBeCloseTo(0.8, 6);
  });

  it("30-day memory decays to half", () => {
    const result = computeDecayScore(
      0.8,
      fixedNow - 30 * MS_PER_DAY,
      0,
      defaultConfig,
    );
    expect(result).toBeCloseTo(0.4, 6);
  });

  it("active count provides boost", () => {
    const low = computeDecayScore(0.8, fixedNow, 0, defaultConfig);
    const high = computeDecayScore(0.8, fixedNow, 10, defaultConfig);
    expect(high).toBeGreaterThan(low);
  });
});

describe("VALID_CATEGORIES", () => {
  it("contains all 6 categories", () => {
    expect(VALID_CATEGORIES.size).toBe(6);
    expect(VALID_CATEGORIES.has("profile")).toBe(true);
    expect(VALID_CATEGORIES.has("preferences")).toBe(true);
    expect(VALID_CATEGORIES.has("entities")).toBe(true);
    expect(VALID_CATEGORIES.has("events")).toBe(true);
    expect(VALID_CATEGORIES.has("cases")).toBe(true);
    expect(VALID_CATEGORIES.has("patterns")).toBe(true);
  });
});
