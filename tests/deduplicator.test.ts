import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryDeduplicator } from "../deduplicator.js";
import type { MemorySearchResult } from "../db.js";
import type { CandidateMemory } from "../types.js";

const mockDb = { search: vi.fn() };
const mockLlm = { completeJson: vi.fn(), complete: vi.fn() };
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDedup() {
  return new MemoryDeduplicator(mockDb as any, mockLlm as any, mockLogger);
}

const candidate: CandidateMemory = {
  category: "events",
  abstract: "Test event",
  overview: "## Event",
  content: "Something happened",
};

function makeSimilar(count: number): MemorySearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    entry: {
      id: `id-${i + 1}`,
      category: "events" as const,
      abstract: `Abstract ${i + 1}`,
      overview: `Overview ${i + 1}`,
      content: `Content ${i + 1}`,
      vector: [0],
      source_session: "s",
      active_count: 0,
      created_at: 0,
      updated_at: 0,
    },
    score: 0.9 - i * 0.05,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MemoryDeduplicator", () => {
  it("returns create when no similar memories found", async () => {
    mockDb.search.mockResolvedValue([]);
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("create");
    expect(result.reason).toContain("No similar");
  });

  it("calls LLM when similar memories exist", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(2));
    mockLlm.completeJson.mockResolvedValue({
      decision: "skip",
      reason: "duplicate",
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("skip");
    expect(mockLlm.completeJson).toHaveBeenCalledOnce();
  });

  it("legacy merge with match_index=1 maps to none + merge action", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(3));
    mockLlm.completeJson.mockResolvedValue({
      decision: "merge",
      reason: "similar to #1",
      match_index: 1,
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions).toEqual([
      {
        id: "id-1",
        action: "merge",
        reason: "Legacy merge mapped to none+merge",
      },
    ]);
  });

  it("legacy merge with match_index=2 targets correct entry", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(3));
    mockLlm.completeJson.mockResolvedValue({
      decision: "merge",
      reason: "similar to #2",
      match_index: 2,
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions[0]).toMatchObject({ id: "id-2", action: "merge" });
  });

  it("legacy merge with match_index=3 targets correct entry", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(3));
    mockLlm.completeJson.mockResolvedValue({
      decision: "merge",
      reason: "similar to #3",
      match_index: 3,
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions[0]).toMatchObject({ id: "id-3", action: "merge" });
  });

  it("legacy merge falls back to first result when match_index out of bounds", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(2));
    mockLlm.completeJson.mockResolvedValue({
      decision: "merge",
      reason: "merge with #5",
      match_index: 5,
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions[0]).toMatchObject({ id: "id-1", action: "merge" });
  });

  it("legacy merge falls back to first result when match_index missing", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(2));
    mockLlm.completeJson.mockResolvedValue({
      decision: "merge",
      reason: "merge",
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions[0]).toMatchObject({ id: "id-1", action: "merge" });
  });

  it("returns empty actions for create decision", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(1));
    mockLlm.completeJson.mockResolvedValue({
      decision: "create",
      reason: "new info",
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("create");
    expect(result.actions).toEqual([]);
  });

  it("returns empty actions for skip decision", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(1));
    mockLlm.completeJson.mockResolvedValue({
      decision: "skip",
      reason: "exact dup",
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("skip");
    expect(result.actions).toEqual([]);
  });

  it("parses two-tier list with merge and delete actions", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(3));
    mockLlm.completeJson.mockResolvedValue({
      decision: "none",
      reason: "update existing",
      list: [
        { id: "id-1", decide: "merge", reason: "same topic" },
        { id: "id-3", decide: "delete", reason: "fully invalidated" },
      ],
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions).toEqual([
      { id: "id-1", action: "merge", reason: "same topic" },
      { id: "id-3", action: "delete", reason: "fully invalidated" },
    ]);
  });

  it("normalizes create + merge to none", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(2));
    mockLlm.completeJson.mockResolvedValue({
      decision: "create",
      reason: "new info",
      list: [{ id: "id-1", decide: "merge", reason: "related" }],
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("none");
    expect(result.actions).toEqual([
      { id: "id-1", action: "merge", reason: "related" },
    ]);
  });

  it("create decision only carries delete actions", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(2));
    mockLlm.completeJson.mockResolvedValue({
      decision: "create",
      reason: "new info",
      list: [{ id: "id-1", decide: "delete", reason: "obsolete" }],
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("create");
    expect(result.actions).toEqual([
      { id: "id-1", action: "delete", reason: "obsolete" },
    ]);
  });

  it("defaults to create for unknown decision", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(1));
    mockLlm.completeJson.mockResolvedValue({
      decision: "INVALID",
      reason: "???",
    });
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("create");
  });

  it("defaults to create when LLM returns null", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(1));
    mockLlm.completeJson.mockResolvedValue(null);
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("create");
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("defaults to create when LLM throws", async () => {
    mockDb.search.mockResolvedValue(makeSimilar(1));
    mockLlm.completeJson.mockRejectedValue(new Error("API failure"));
    const result = await makeDedup().deduplicate(candidate, [0.1]);
    expect(result.decision).toBe("create");
    expect(result.reason).toContain("API failure");
  });
});
