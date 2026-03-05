import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryExtractor } from "../extractor.js";
import type { ExtractionCheckpoint } from "../checkpoint.js";

const mockDb = {
  store: vi.fn(),
  update: vi.fn(),
  findByCategory: vi.fn(),
  getById: vi.fn(),
  deleteById: vi.fn(),
};
const mockEmbeddings = { embed: vi.fn() };
const mockLlm = { completeJson: vi.fn(), complete: vi.fn() };
const mockDedup = { deduplicate: vi.fn() };
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeExtractor() {
  return new MemoryExtractor(
    mockDb as any,
    mockEmbeddings as any,
    mockLlm as any,
    mockDedup as any,
    mockLogger,
  );
}

function makeCheckpointMgr() {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
    findIncomplete: vi.fn().mockResolvedValue([]),
    createInitial: vi.fn(
      (
        sessionKey: string,
        candidates: unknown[],
        user: string,
      ): ExtractionCheckpoint => ({
        sessionKey,
        stage: "extracting",
        candidates: candidates as any,
        processedIndex: -1,
        timestamp: Date.now(),
        user,
      }),
    ),
    updateProgress: vi.fn(
      (
        cp: ExtractionCheckpoint,
        index: number,
        stage: string,
      ): ExtractionCheckpoint => ({
        ...cp,
        processedIndex: index,
        stage: stage as any,
        timestamp: Date.now(),
      }),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbeddings.embed.mockResolvedValue([0.1, 0.2, 0.3]);
  mockDedup.deduplicate.mockResolvedValue({
    decision: "create",
    reason: "new",
    actions: [],
  });
  mockDb.store.mockResolvedValue({});
});

describe("MemoryExtractor checkpoint idempotency contracts", () => {
  it("extractWithCheckpoint should not replay a candidate after processCandidate succeeds but checkpoint.save fails", async () => {
    const extractor = makeExtractor();

    // Two candidates
    mockLlm.completeJson.mockResolvedValue({
      memories: [
        { category: "events", abstract: "a1", overview: "o1", content: "c1" },
        { category: "events", abstract: "a2", overview: "o2", content: "c2" },
      ],
    });

    const mgr = makeCheckpointMgr();
    // Initial save succeeds, candidate[0] save succeeds, candidate[1] save fails
    mgr.save
      .mockResolvedValueOnce(undefined) // initial checkpoint
      .mockResolvedValueOnce(undefined) // after candidate[0]
      .mockRejectedValueOnce(new Error("disk full")); // after candidate[1]

    const stats = await extractor.extractWithCheckpoint(
      "conv",
      "s1",
      "user",
      mgr as any,
    );

    // Both candidates processed exactly once — no replay
    expect(mockDb.store).toHaveBeenCalledTimes(2);
    expect(stats.created).toBe(2);

    // Extraction completed: checkpoint cleared
    expect(mgr.clear).toHaveBeenCalledWith("s1");

    // Warning logged for failed save
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("checkpoint save failed"),
    );
  });

  it("resumeFromCheckpoint should not replay a candidate that already produced side effects before a checkpoint persistence failure", async () => {
    const extractor = makeExtractor();

    // Checkpoint: candidate[0] already processed; candidates[1..2] pending
    const checkpoint: ExtractionCheckpoint = {
      sessionKey: "s1",
      stage: "storing",
      candidates: [
        { category: "events", abstract: "a0", overview: "o0", content: "c0" },
        { category: "events", abstract: "a1", overview: "o1", content: "c1" },
        { category: "events", abstract: "a2", overview: "o2", content: "c2" },
      ],
      processedIndex: 0,
      timestamp: Date.now(),
      user: "user",
    };

    const mgr = makeCheckpointMgr();
    mgr.findIncomplete.mockResolvedValue([checkpoint]);

    // candidate[1] save succeeds, candidate[2] save fails
    mgr.save
      .mockResolvedValueOnce(undefined) // after candidate[1]
      .mockRejectedValueOnce(new Error("disk full")); // after candidate[2]

    const results = await extractor.resumeIncomplete(mgr as any);

    // Only candidates[1] and [2] are processed (candidate[0] was already done)
    expect(mockDb.store).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
    expect(results[0].created).toBe(2);

    // Checkpoint cleared despite save failure
    expect(mgr.clear).toHaveBeenCalledWith("s1");

    // Warning logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("checkpoint save failed"),
    );
  });
});
