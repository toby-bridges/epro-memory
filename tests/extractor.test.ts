import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryExtractor } from "../extractor.js";

const mockDb = {
  store: vi.fn(),
  update: vi.fn(),
  findByCategory: vi.fn(),
  getById: vi.fn(),
};
const mockEmbeddings = { embed: vi.fn() };
const mockLlm = { completeJson: vi.fn(), complete: vi.fn() };
const mockDedup = { deduplicate: vi.fn() };
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeExtractor() {
  return new MemoryExtractor(
    mockDb as any,
    mockEmbeddings as any,
    mockLlm as any,
    mockDedup as any,
    mockLogger,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbeddings.embed.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe("MemoryExtractor.extractAndPersist", () => {
  it("returns zero stats when LLM extracts no memories", async () => {
    mockLlm.completeJson.mockResolvedValue({ memories: [] });
    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats).toEqual({ created: 0, merged: 0, skipped: 0 });
  });

  it("returns zero stats when LLM returns null", async () => {
    mockLlm.completeJson.mockResolvedValue(null);
    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats).toEqual({ created: 0, merged: 0, skipped: 0 });
  });

  it("filters out invalid categories from LLM output", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "invalid", abstract: "a", overview: "o", content: "c" },
        { category: "events", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockResolvedValue({
      decision: "create",
      reason: "new",
    });
    mockDb.store.mockResolvedValue({});

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.created).toBe(1); // only "events" passed
    expect(mockDb.store).toHaveBeenCalledOnce();
  });

  it("filters out memories missing abstract or content", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "events", abstract: "", overview: "o", content: "c" },
        { category: "events", abstract: "a", overview: "o", content: "" },
        { category: "events", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockResolvedValue({
      decision: "create",
      reason: "new",
    });
    mockDb.store.mockResolvedValue({});

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.created).toBe(1);
  });

  // --- Profile always-merge path ---

  it("creates profile when none exists", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "profile", abstract: "User info", overview: "## Info", content: "Details" },
      ],
    });
    mockDb.findByCategory.mockResolvedValue([]);
    mockDb.store.mockResolvedValue({});

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.merged).toBe(1);
    expect(mockDb.store).toHaveBeenCalledWith(
      expect.objectContaining({ category: "profile" }),
    );
  });

  it("merges profile with existing using all 3 levels", async () => {
    mockLlm.completeJson
      // First call: extraction
      .mockResolvedValueOnce({
        memories: [
          { category: "profile", abstract: "New info", overview: "## New", content: "New details" },
        ],
      })
      // Second call: merge
      .mockResolvedValueOnce({
        abstract: "Merged abstract",
        overview: "## Merged overview",
        content: "Merged content",
      });

    mockDb.findByCategory.mockResolvedValue([
      {
        id: "existing-id",
        category: "profile",
        abstract: "Old info",
        overview: "## Old",
        content: "Old details",
      },
    ]);
    mockDb.update.mockResolvedValue(undefined);

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.merged).toBe(1);
    expect(mockDb.update).toHaveBeenCalledWith(
      "existing-id",
      expect.objectContaining({
        abstract: "Merged abstract",
        overview: "## Merged overview",
        content: "Merged content",
      }),
    );
  });

  it("falls back to candidate values when merge LLM returns bad JSON", async () => {
    mockLlm.completeJson
      .mockResolvedValueOnce({
        memories: [
          { category: "profile", abstract: "New", overview: "O", content: "C" },
        ],
      })
      .mockResolvedValueOnce(null); // merge fails

    mockDb.findByCategory.mockResolvedValue([
      { id: "eid", category: "profile", abstract: "Old", overview: "O", content: "Old" },
    ]);
    mockDb.update.mockResolvedValue(undefined);

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.merged).toBe(1);
    expect(mockDb.update).toHaveBeenCalledWith(
      "eid",
      expect.objectContaining({
        abstract: "New",
        content: "C",
      }),
    );
  });

  // --- Non-profile dedup path ---

  it("creates memory when dedup returns create", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "events", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockResolvedValue({
      decision: "create",
      reason: "new",
    });
    mockDb.store.mockResolvedValue({});

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.created).toBe(1);
  });

  it("skips when dedup returns skip", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "events", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockResolvedValue({
      decision: "skip",
      reason: "duplicate",
    });

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.skipped).toBe(1);
    expect(mockDb.store).not.toHaveBeenCalled();
  });

  it("merges with getById for merge-supported categories", async () => {
    mockLlm.completeJson
      .mockResolvedValueOnce({
        memories: [
          { category: "preferences", abstract: "a", overview: "o", content: "c" },
        ],
      })
      .mockResolvedValueOnce({
        abstract: "merged-a",
        overview: "merged-o",
        content: "merged-c",
      });

    mockDedup.deduplicate.mockResolvedValue({
      decision: "merge",
      reason: "overlap",
      matchId: "match-id",
    });
    mockDb.getById.mockResolvedValue({
      id: "match-id",
      category: "preferences",
      abstract: "old-a",
      overview: "old-o",
      content: "old-c",
    });
    mockDb.update.mockResolvedValue(undefined);

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.merged).toBe(1);
    expect(mockDb.getById).toHaveBeenCalledWith("match-id");
    expect(mockDb.update).toHaveBeenCalledWith(
      "match-id",
      expect.objectContaining({ abstract: "merged-a" }),
    );
  });

  it("creates instead of merge for non-mergeable categories (events)", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "events", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockResolvedValue({
      decision: "merge",
      reason: "similar",
      matchId: "id",
    });
    mockDb.store.mockResolvedValue({});

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.created).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.store).toHaveBeenCalledWith(
      expect.objectContaining({ category: "events", abstract: "a" }),
    );
  });

  it("creates instead of merge for non-mergeable categories (cases)", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "cases", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockResolvedValue({
      decision: "merge",
      reason: "similar",
      matchId: "id",
    });
    mockDb.store.mockResolvedValue({});

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.created).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it("counts as skipped when processCandidate throws", async () => {
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "events", abstract: "a", overview: "o", content: "c" },
      ],
    });
    mockDedup.deduplicate.mockRejectedValue(new Error("boom"));

    const stats = await makeExtractor().extractAndPersist("conv", "s1", "user");
    expect(stats.skipped).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
