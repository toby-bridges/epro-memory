/**
 * Tests for QMD projection functionality.
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatCategoryMarkdown,
  generateDailySummary,
  shouldRunProjection,
  type ProjectionConfig,
} from "../projector.js";
import type { AgentMemoryRow } from "../types.js";

// Helper to create test memories
function createMemory(
  overrides: Partial<AgentMemoryRow> = {},
): AgentMemoryRow {
  const now = Date.now();
  return {
    id: "12345678-1234-1234-1234-123456789abc",
    category: "cases",
    abstract: "Test abstract",
    overview: "Test overview with more details",
    content: "Full content here",
    vector: [0.1, 0.2, 0.3],
    source_session: "test-session",
    active_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("formatCategoryMarkdown", () => {
  it("should format category with L0 only when includeL1 is false", () => {
    const memories = [createMemory({ abstract: "Memory abstract" })];
    const result = formatCategoryMarkdown("cases", memories, false);

    expect(result).toContain("# Cases (问题解决方案)");
    expect(result).toContain("**摘要**: Memory abstract");
    expect(result).not.toContain("**详情**:");
    expect(result).toContain("记忆数量: 1");
  });

  it("should format category with L0 + L1 when includeL1 is true", () => {
    const memories = [
      createMemory({
        abstract: "Memory abstract",
        overview: "Detailed overview",
      }),
    ];
    const result = formatCategoryMarkdown("cases", memories, true);

    expect(result).toContain("**摘要**: Memory abstract");
    expect(result).toContain("**详情**:");
    expect(result).toContain("Detailed overview");
  });

  it("should include memory metadata", () => {
    const memories = [
      createMemory({
        active_count: 5,
        source_session: "session-123",
      }),
    ];
    const result = formatCategoryMarkdown("cases", memories, false);

    expect(result).toContain("活跃: 5 次");
    expect(result).toContain("来源: session-123");
  });

  it("should sort memories by active_count then created_at", () => {
    const now = Date.now();
    const memories = [
      createMemory({
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        abstract: "Low active, old",
        active_count: 1,
        created_at: now - 100000,
      }),
      createMemory({
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        abstract: "High active",
        active_count: 10,
        created_at: now - 50000,
      }),
      createMemory({
        id: "cccccccc-0000-0000-0000-000000000003",
        abstract: "Low active, new",
        active_count: 1,
        created_at: now,
      }),
    ];

    const result = formatCategoryMarkdown("cases", memories, false);

    // High active should come first
    const highActivePos = result.indexOf("High active");
    const lowActiveNewPos = result.indexOf("Low active, new");
    const lowActiveOldPos = result.indexOf("Low active, old");

    expect(highActivePos).toBeLessThan(lowActiveNewPos);
    expect(lowActiveNewPos).toBeLessThan(lowActiveOldPos);
  });

  it("should handle all category types", () => {
    const categories = [
      "profile",
      "preferences",
      "entities",
      "events",
      "cases",
      "patterns",
    ] as const;

    for (const category of categories) {
      const memories = [createMemory({ category })];
      const result = formatCategoryMarkdown(category, memories, false);
      expect(result).toContain("# ");
      expect(result).toContain("记忆数量: 1");
    }
  });

  it("should handle empty memories array", () => {
    const result = formatCategoryMarkdown("cases", [], false);
    expect(result).toContain("记忆数量: 0");
  });

  it("should truncate memory ID to 8 characters", () => {
    const memories = [
      createMemory({ id: "abcdef12-3456-7890-abcd-ef1234567890" }),
    ];
    const result = formatCategoryMarkdown("cases", memories, false);
    expect(result).toContain("## abcdef12");
  });
});

describe("generateDailySummary", () => {
  it("should include total memory count", () => {
    const memories = [createMemory(), createMemory(), createMemory()];
    const result = generateDailySummary(memories);

    expect(result).toContain("总记忆数: 3");
  });

  it("should count today's new memories", () => {
    const now = Date.now();
    const memories = [
      createMemory({ created_at: now - 1000 }), // Today
      createMemory({ created_at: now - 2 * 24 * 60 * 60 * 1000 }), // 2 days ago
    ];
    const result = generateDailySummary(memories);

    expect(result).toContain("今日新增: 1");
  });

  it("should count yesterday's new memories", () => {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];
    const todayStart = new Date(today).getTime();
    const yesterdayTime = todayStart - 12 * 60 * 60 * 1000; // 12 hours before today start

    const memories = [
      createMemory({ created_at: now - 1000 }), // Today
      createMemory({ created_at: yesterdayTime }), // Yesterday
    ];
    const result = generateDailySummary(memories);

    expect(result).toContain("昨日新增: 1");
  });

  it("should show category distribution", () => {
    const memories = [
      createMemory({ category: "cases" }),
      createMemory({ category: "cases" }),
      createMemory({ category: "patterns" }),
    ];
    const result = generateDailySummary(memories);

    expect(result).toContain("cases: 2");
    expect(result).toContain("patterns: 1");
  });

  it("should show top 5 most active memories", () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      createMemory({
        id: `${i}0000000-0000-0000-0000-000000000000`,
        abstract: `Memory ${i}`,
        active_count: i,
      }),
    );
    const result = generateDailySummary(memories);

    // Should show top 5 (active_count 9, 8, 7, 6, 5)
    expect(result).toContain("Memory 9 (9次)");
    expect(result).toContain("Memory 5 (5次)");
    // Should not show lower active ones
    expect(result).not.toContain("Memory 4 (4次)");
  });

  it("should handle empty memories array", () => {
    const result = generateDailySummary([]);

    expect(result).toContain("总记忆数: 0");
    expect(result).toContain("今日新增: 0");
    expect(result).toContain("(无记忆)");
  });

  it("should include generation timestamp", () => {
    const memories = [createMemory()];
    const result = generateDailySummary(memories);

    expect(result).toContain("自动生成于");
  });
});

describe("shouldRunProjection", () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;

  it("should return true if no previous projection", () => {
    const result = shouldRunProjection(0, ONE_DAY, Date.now());
    expect(result).toBe(true);
  });

  it("should return true if more than interval since last projection", () => {
    const now = Date.now();
    const oneDayAgo = now - 25 * 60 * 60 * 1000; // 25 hours ago
    const result = shouldRunProjection(oneDayAgo, ONE_DAY, now);
    expect(result).toBe(true);
  });

  it("should return false if less than interval since last projection", () => {
    const now = Date.now();
    const twelveHoursAgo = now - 12 * 60 * 60 * 1000;
    const result = shouldRunProjection(twelveHoursAgo, ONE_DAY, now);
    expect(result).toBe(false);
  });

  it("should return true at exactly the interval boundary", () => {
    const now = Date.now();
    const exactlyOneDayAgo = now - ONE_DAY;
    const result = shouldRunProjection(exactlyOneDayAgo, ONE_DAY, now);
    expect(result).toBe(true);
  });

  it("should respect custom interval (e.g. 1 hour)", () => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const twoHoursAgo = now - 2 * oneHour;
    expect(shouldRunProjection(twoHoursAgo, oneHour, now)).toBe(true);

    const thirtyMinAgo = now - 30 * 60 * 1000;
    expect(shouldRunProjection(thirtyMinAgo, oneHour, now)).toBe(false);
  });
});
