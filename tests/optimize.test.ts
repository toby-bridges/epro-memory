import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../db.js";
import type { MemoryCategory, PluginLogger } from "../types.js";
import { parseConfig, DEFAULTS } from "../config.js";

// --- Unit tests (mocked table) ---

describe("MemoryDB.optimize() unit", () => {
  const logger: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  it("calculates cleanup date correctly for custom days", async () => {
    const db = new MemoryDB("/tmp/fake", 3, logger);

    // Access private table via prototype trick: stub ensureInit + table
    const fakeTable = {
      optimize: vi.fn().mockResolvedValue({
        compaction: { fragmentsRemoved: 2, fragmentsAdded: 1, filesRemoved: 3, filesAdded: 1 },
        prune: { bytesRemoved: 100, oldVersionsRemoved: 1 },
      }),
    };
    (db as any).table = fakeTable;

    const now = Date.now();
    const result = await db.optimize(14);

    expect(fakeTable.optimize).toHaveBeenCalledOnce();
    const callArg = fakeTable.optimize.mock.calls[0][0];
    const expectedMs = 14 * 24 * 60 * 60 * 1000;
    // The cleanup date should be ~14 days ago
    expect(callArg.cleanupOlderThan).toBeInstanceOf(Date);
    const diff = now - callArg.cleanupOlderThan.getTime();
    expect(diff).toBeGreaterThan(expectedMs - 1000);
    expect(diff).toBeLessThan(expectedMs + 1000);
  });

  it("maps stats correctly from LanceDB response", async () => {
    const db = new MemoryDB("/tmp/fake", 3, logger);
    const fakeTable = {
      optimize: vi.fn().mockResolvedValue({
        compaction: { fragmentsRemoved: 5, fragmentsAdded: 2, filesRemoved: 10, filesAdded: 3 },
        prune: { bytesRemoved: 5000, oldVersionsRemoved: 3 },
      }),
    };
    (db as any).table = fakeTable;

    const result = await db.optimize();
    expect(result).toEqual({
      compaction: { fragmentsRemoved: 5, fragmentsAdded: 2 },
      prune: { bytesRemoved: 5000, oldVersionsRemoved: 3 },
    });
  });

  it("returns null and logs warning on error", async () => {
    const warnFn = vi.fn();
    const db = new MemoryDB("/tmp/fake", 3, { ...logger, warn: warnFn });
    const fakeTable = {
      optimize: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    (db as any).table = fakeTable;

    const result = await db.optimize();
    expect(result).toBeNull();
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("optimize failed"),
    );
  });

  it("defaults to 7 days when no argument given", async () => {
    const db = new MemoryDB("/tmp/fake", 3, logger);
    const fakeTable = {
      optimize: vi.fn().mockResolvedValue({
        compaction: { fragmentsRemoved: 0, fragmentsAdded: 0, filesRemoved: 0, filesAdded: 0 },
        prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
      }),
    };
    (db as any).table = fakeTable;

    const now = Date.now();
    await db.optimize();

    const callArg = fakeTable.optimize.mock.calls[0][0];
    const expectedMs = 7 * 24 * 60 * 60 * 1000;
    const diff = now - callArg.cleanupOlderThan.getTime();
    expect(diff).toBeGreaterThan(expectedMs - 1000);
    expect(diff).toBeLessThan(expectedMs + 1000);
  });

  it("calls ensureInit before optimizing", async () => {
    const db = new MemoryDB("/tmp/fake", 3, logger);
    const ensureInitSpy = vi.spyOn(db as any, "ensureInit");
    const fakeTable = {
      optimize: vi.fn().mockResolvedValue({
        compaction: { fragmentsRemoved: 0, fragmentsAdded: 0, filesRemoved: 0, filesAdded: 0 },
        prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
      }),
    };
    (db as any).table = fakeTable;

    await db.optimize();
    expect(ensureInitSpy).toHaveBeenCalledOnce();
  });
});

// --- Integration tests ---

const describeIfIntegration =
  process.env.RUN_LANCEDB_INTEGRATION === "1" ? describe : describe.skip;

const silentLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeEntry(category: MemoryCategory, n: number) {
  return {
    category,
    abstract: `${category}-abstract-${n}`,
    overview: `## ${category} overview ${n}`,
    content: `${category} content ${n}`,
    vector: [n, n + 0.1, n + 0.2],
    source_session: `session-${n}`,
  };
}

describeIfIntegration("MemoryDB.optimize() integration", () => {
  let dbPath = "";
  let db: MemoryDB;

  beforeEach(async () => {
    dbPath = await mkdtemp(join(tmpdir(), "epro-opt-it-"));
    db = new MemoryDB(dbPath, 3, silentLogger);
  });

  afterEach(async () => {
    if (!dbPath) return;
    await rm(dbPath, { recursive: true, force: true }).catch(() => {});
  });

  it("runs optimize on a real LanceDB table", async () => {
    await db.store(makeEntry("events", 1));
    const result = await db.optimize();
    expect(result).not.toBeNull();
    expect(result!.compaction).toBeDefined();
    expect(result!.prune).toBeDefined();
  });

  it("compacts after multiple updates", async () => {
    const row = await db.store(makeEntry("events", 1));
    // Create multiple versions
    for (let i = 0; i < 5; i++) {
      await db.update(row.id, { abstract: `updated-${i}` });
    }
    const result = await db.optimize(0);
    expect(result).not.toBeNull();
    expect(typeof result!.compaction.fragmentsRemoved).toBe("number");
  });
});

// --- Config tests ---

describe("config: optimizeAfterExtraction", () => {
  it("defaults to true", () => {
    expect(DEFAULTS.optimizeAfterExtraction).toBe(true);
  });

  it("accepts false", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      optimizeAfterExtraction: false,
    });
    expect(cfg.optimizeAfterExtraction).toBe(false);
  });
});
