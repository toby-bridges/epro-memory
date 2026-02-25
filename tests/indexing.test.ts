import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../db.js";
import type { MemoryCategory, PluginLogger } from "../types.js";
import { parseConfig, DEFAULTS } from "../config.js";

// --- Unit tests (mocked table) ---

describe("MemoryDB.ensureIndices() unit", () => {
  const logger: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  function makeDb(loggerOverride?: Partial<PluginLogger>) {
    return new MemoryDB("/tmp/fake-idx", 3, { ...logger, ...loggerOverride });
  }

  function makeFakeTable(opts: {
    indices?: Array<{ name: string; indexType: string; columns: string[] }>;
    rowCount?: number;
  } = {}) {
    return {
      listIndices: vi.fn().mockResolvedValue(opts.indices ?? []),
      countRows: vi.fn().mockResolvedValue(opts.rowCount ?? 0),
      createIndex: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("creates bitmap index on category when not present", async () => {
    const db = makeDb();
    const table = makeFakeTable();
    (db as any).table = table;

    await db.ensureIndices();

    expect(table.createIndex).toHaveBeenCalledWith("category", {
      config: expect.anything(),
    });
  });

  it("skips bitmap index if category index already exists", async () => {
    const db = makeDb();
    const table = makeFakeTable({
      indices: [{ name: "category_idx", indexType: "BITMAP", columns: ["category"] }],
      rowCount: 500,
    });
    (db as any).table = table;

    await db.ensureIndices();

    // Should not call createIndex for category
    const categoryCalls = table.createIndex.mock.calls.filter(
      (c: any[]) => c[0] === "category",
    );
    expect(categoryCalls.length).toBe(0);
  });

  it("creates vector index when rows >= threshold", async () => {
    const db = makeDb();
    const table = makeFakeTable({ rowCount: 1500 });
    (db as any).table = table;

    await db.ensureIndices(1000);

    const vectorCalls = table.createIndex.mock.calls.filter(
      (c: any[]) => c[0] === "vector",
    );
    expect(vectorCalls.length).toBe(1);
  });

  it("skips vector index when rows < threshold", async () => {
    const db = makeDb();
    const table = makeFakeTable({ rowCount: 500 });
    (db as any).table = table;

    await db.ensureIndices(1000);

    const vectorCalls = table.createIndex.mock.calls.filter(
      (c: any[]) => c[0] === "vector",
    );
    expect(vectorCalls.length).toBe(0);
  });

  it("skips vector index if vector index already exists", async () => {
    const db = makeDb();
    const table = makeFakeTable({
      indices: [{ name: "vector_idx", indexType: "IVF_PQ", columns: ["vector"] }],
      rowCount: 2000,
    });
    (db as any).table = table;

    await db.ensureIndices(1000);

    const vectorCalls = table.createIndex.mock.calls.filter(
      (c: any[]) => c[0] === "vector",
    );
    expect(vectorCalls.length).toBe(0);
  });

  it("uses sqrt(rows) for numPartitions", async () => {
    const db = makeDb();
    const table = makeFakeTable({ rowCount: 10000 });
    (db as any).table = table;

    await db.ensureIndices(1000);

    const vectorCalls = table.createIndex.mock.calls.filter(
      (c: any[]) => c[0] === "vector",
    );
    expect(vectorCalls.length).toBe(1);
    // sqrt(10000) = 100
    const indexConfig = vectorCalls[0][1].config;
    expect(indexConfig).toBeDefined();
  });

  it("catches errors and logs warning", async () => {
    const warnFn = vi.fn();
    const db = makeDb({ warn: warnFn });
    const table = {
      listIndices: vi.fn().mockRejectedValue(new Error("index error")),
      countRows: vi.fn().mockResolvedValue(0),
      createIndex: vi.fn(),
    };
    (db as any).table = table;

    // Should not throw
    await db.ensureIndices();
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining("ensureIndices failed"),
    );
  });

  it("defaults vectorIndexThreshold to 1000", async () => {
    const db = makeDb();
    const table = makeFakeTable({ rowCount: 999 });
    (db as any).table = table;

    await db.ensureIndices(); // default threshold = 1000

    const vectorCalls = table.createIndex.mock.calls.filter(
      (c: any[]) => c[0] === "vector",
    );
    expect(vectorCalls.length).toBe(0);
  });
});

describe("MemoryDB.countRows() unit", () => {
  it("returns row count from table", async () => {
    const logger: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const db = new MemoryDB("/tmp/fake-cnt", 3, logger);
    const table = { countRows: vi.fn().mockResolvedValue(42) };
    (db as any).table = table;

    const count = await db.countRows();
    expect(count).toBe(42);
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

describeIfIntegration("MemoryDB indexing integration", () => {
  let dbPath = "";
  let db: MemoryDB;

  beforeEach(async () => {
    dbPath = await mkdtemp(join(tmpdir(), "epro-idx-it-"));
    db = new MemoryDB(dbPath, 3, silentLogger);
  });

  afterEach(async () => {
    if (!dbPath) return;
    await rm(dbPath, { recursive: true, force: true }).catch(() => {});
  });

  it("creates bitmap index on real LanceDB table", async () => {
    await db.store(makeEntry("events", 1));
    await db.ensureIndices(100000); // high threshold to skip vector index
    // Should not throw; bitmap index created
    const count = await db.countRows();
    expect(count).toBe(1);
  });

  it("countRows returns correct count", async () => {
    await db.store(makeEntry("events", 1));
    await db.store(makeEntry("profile", 2));
    await db.store(makeEntry("patterns", 3));

    const count = await db.countRows();
    expect(count).toBe(3);
  });
});

// --- Config tests ---

describe("config: autoIndex", () => {
  it("defaults to true", () => {
    expect(DEFAULTS.autoIndex).toBe(true);
  });

  it("accepts false", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      autoIndex: false,
    });
    expect(cfg.autoIndex).toBe(false);
  });
});

describe("config: indexThreshold", () => {
  it("defaults to 1000", () => {
    expect(DEFAULTS.indexThreshold).toBe(1000);
  });

  it("accepts valid value", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      indexThreshold: 5000,
    });
    expect(cfg.indexThreshold).toBe(5000);
  });

  it("throws when below minimum (100)", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        indexThreshold: 50,
      }),
    ).toThrow("indexThreshold must be a number between 100 and 100000");
  });

  it("throws when above maximum (100000)", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        indexThreshold: 200000,
      }),
    ).toThrow("indexThreshold must be a number between 100 and 100000");
  });

  it("throws when indexThreshold is a string", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        indexThreshold: "foo" as unknown,
      }),
    ).toThrow("indexThreshold must be a number, got string");
  });
});
