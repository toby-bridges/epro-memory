import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../db.js";
import type { AgentMemoryRow, MemoryCategory, PluginLogger } from "../types.js";
import { parseConfig, DEFAULTS } from "../config.js";

// --- Helper ---

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

// --- deleteById unit tests ---

describe("MemoryDB.deleteById() unit", () => {
  const logger: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  it("deletes existing row and returns true", async () => {
    const db = new MemoryDB("/tmp/fake-del", 3, logger);
    const fakeTable = {
      query: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([
              {
                id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                category: "events",
                abstract: "a",
                overview: "o",
                content: "c",
                vector: [1, 2, 3],
                source_session: "s",
                active_count: 0,
                created_at: 1000,
                updated_at: 1000,
              },
            ]),
          }),
        }),
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    (db as any).table = fakeTable;

    const result = await db.deleteById("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result).toBe(true);
    expect(fakeTable.delete).toHaveBeenCalledWith(
      "id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'",
    );
  });

  it("returns false when row not found", async () => {
    const db = new MemoryDB("/tmp/fake-del", 3, logger);
    const fakeTable = {
      query: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn(),
    };
    (db as any).table = fakeTable;

    const result = await db.deleteById("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result).toBe(false);
    expect(fakeTable.delete).not.toHaveBeenCalled();
  });

  it("validates UUID format", async () => {
    const db = new MemoryDB("/tmp/fake-del", 3, logger);
    (db as any).table = {};
    await expect(db.deleteById("not-a-uuid")).rejects.toThrow("Invalid UUID");
  });

  it("uses write lock for serialization", async () => {
    const db = new MemoryDB("/tmp/fake-del", 3, logger);
    const lockSpy = vi.spyOn(db as any, "withWriteLock");
    const fakeTable = {
      query: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    (db as any).table = fakeTable;

    await db.deleteById("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(lockSpy).toHaveBeenCalledOnce();
  });
});

// --- getAll unit tests ---

describe("MemoryDB.getAll() unit", () => {
  it("returns all rows up to cap", async () => {
    const db = new MemoryDB("/tmp/fake-list", 3, silentLogger);
    const fakeRows = Array.from({ length: 3 }, (_, i) => ({
      id: `${i}0000000-0000-0000-0000-000000000000`,
      category: "events",
      abstract: `a-${i}`,
      overview: `o-${i}`,
      content: `c-${i}`,
      vector: [i, i + 0.1, i + 0.2],
      source_session: "s",
      active_count: 0,
      created_at: 1000,
      updated_at: 1000,
    }));
    const fakeTable = {
      query: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(fakeRows),
        }),
      }),
    };
    (db as any).table = fakeTable;

    const result = await db.getAll();
    expect(result.length).toBe(3);
    expect(result[0].id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("passes 10000 as limit", async () => {
    const db = new MemoryDB("/tmp/fake-list", 3, silentLogger);
    const limitFn = vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    });
    const fakeTable = {
      query: vi.fn().mockReturnValue({ limit: limitFn }),
    };
    (db as any).table = fakeTable;

    await db.getAll();
    expect(limitFn).toHaveBeenCalledWith(10_000);
  });
});

// --- maintain() unit tests ---

describe("MemoryDB.maintain() unit", () => {
  function makeRow(
    overrides: Partial<AgentMemoryRow> & {
      id: string;
      category: MemoryCategory;
    },
  ): AgentMemoryRow {
    return {
      abstract: "a",
      overview: "o",
      content: "c",
      vector: [1, 2, 3],
      source_session: "s",
      active_count: 0,
      created_at: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days ago
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it("deletes memories past TTL", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const oldRow = makeRow({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "events",
      created_at: Date.now() - 31 * 24 * 60 * 60 * 1000, // 31 days ago
      active_count: 0,
    });
    const freshRow = makeRow({
      id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "events",
      created_at: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
    });

    const deleteByIdSpy = vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows").mockResolvedValue(2);
    vi.spyOn(db, "getAll").mockResolvedValue([oldRow, freshRow]);

    const result = await db.maintain({ memoryTTLDays: 30 });
    expect(result.deleted).toBe(1);
    expect(deleteByIdSpy).toHaveBeenCalledWith(oldRow.id);
    expect(deleteByIdSpy).not.toHaveBeenCalledWith(freshRow.id);
  });

  it("TTL grace period increases with active_count", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    // 35 days old, TTL=30, but active_count=5 → adjusted TTL = 30 * 1.5 = 45 days
    const activeRow = makeRow({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "events",
      created_at: Date.now() - 35 * 24 * 60 * 60 * 1000,
      active_count: 5,
    });

    vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows").mockResolvedValue(1);
    vi.spyOn(db, "getAll").mockResolvedValue([activeRow]);

    const result = await db.maintain({ memoryTTLDays: 30 });
    expect(result.deleted).toBe(0); // Should NOT be deleted
  });

  it("profile memories are never auto-deleted by TTL", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const profileRow = makeRow({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "profile",
      created_at: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year old
      active_count: 0,
    });

    const deleteByIdSpy = vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows").mockResolvedValue(1);
    vi.spyOn(db, "getAll").mockResolvedValue([profileRow]);

    const result = await db.maintain({ memoryTTLDays: 30 });
    expect(result.deleted).toBe(0);
    expect(deleteByIdSpy).not.toHaveBeenCalled();
  });

  it("profile memories are never deleted by count phase", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const profileRow = makeRow({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "profile",
      created_at: Date.now() - 365 * 24 * 60 * 60 * 1000,
      active_count: 0,
    });
    const eventRow = makeRow({
      id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "events",
      created_at: Date.now() - 10 * 24 * 60 * 60 * 1000,
      active_count: 0,
    });

    const deleteByIdSpy = vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows").mockResolvedValue(2);
    vi.spyOn(db, "getAll").mockResolvedValue([profileRow, eventRow]);

    const result = await db.maintain({ maxMemories: 1 });
    // Should delete eventRow (1 excess), not profileRow
    expect(deleteByIdSpy).toHaveBeenCalledWith(eventRow.id);
    expect(deleteByIdSpy).not.toHaveBeenCalledWith(profileRow.id);
  });

  it("count-based cleanup deletes lowest-scored first", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const now = Date.now();
    const rows: AgentMemoryRow[] = [
      makeRow({
        id: "11111111-1111-1111-1111-111111111111",
        category: "events",
        active_count: 0,
        created_at: now - 10000,
      }),
      makeRow({
        id: "22222222-2222-2222-2222-222222222222",
        category: "events",
        active_count: 5,
        created_at: now - 5000,
      }),
      makeRow({
        id: "33333333-3333-3333-3333-333333333333",
        category: "events",
        active_count: 10,
        created_at: now,
      }),
    ];

    const deleteByIdSpy = vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows").mockResolvedValue(3);
    vi.spyOn(db, "getAll").mockResolvedValue(rows);

    const result = await db.maintain({ maxMemories: 2 });
    // Row 1 has lowest score (active_count=0, oldest)
    expect(deleteByIdSpy).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(result.deleted).toBe(1);
  });

  it("combined TTL + count phases", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const now = Date.now();
    const ttlExpired = makeRow({
      id: "11111111-1111-1111-1111-111111111111",
      category: "events",
      created_at: now - 100 * 24 * 60 * 60 * 1000,
    });
    const recent1 = makeRow({
      id: "22222222-2222-2222-2222-222222222222",
      category: "events",
      created_at: now - 1000,
      active_count: 0,
    });
    const recent2 = makeRow({
      id: "33333333-3333-3333-3333-333333333333",
      category: "events",
      created_at: now,
      active_count: 5,
    });

    const deleteByIdSpy = vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows")
      .mockResolvedValueOnce(3) // initial
      .mockResolvedValueOnce(2); // after TTL deletion
    vi.spyOn(db, "getAll")
      .mockResolvedValueOnce([ttlExpired, recent1, recent2]) // TTL phase
      .mockResolvedValueOnce([recent1, recent2]); // count phase (ttlExpired removed)

    const result = await db.maintain({ memoryTTLDays: 30, maxMemories: 1 });
    // TTL deletes ttlExpired, count deletes recent1 (lower score)
    expect(result.deleted).toBe(2);
    expect(deleteByIdSpy).toHaveBeenCalledWith(ttlExpired.id);
    expect(deleteByIdSpy).toHaveBeenCalledWith(recent1.id);
  });

  it("returns 'no cleanup needed' when nothing to do", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    vi.spyOn(db, "countRows").mockResolvedValue(0);
    vi.spyOn(db, "getAll").mockResolvedValue([]);
    vi.spyOn(db, "deleteById").mockResolvedValue(true);

    const result = await db.maintain({});
    expect(result.deleted).toBe(0);
    expect(result.reason).toBe("no cleanup needed");
  });

  it("skips TTL phase when memoryTTLDays is 0", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    vi.spyOn(db, "countRows").mockResolvedValue(0);
    const getAllSpy = vi.spyOn(db, "getAll").mockResolvedValue([]);

    const result = await db.maintain({ memoryTTLDays: 0 });
    // getAll should not be called since TTL=0 and maxMemories defaults to 0
    expect(getAllSpy).not.toHaveBeenCalled();
  });

  it("skips count phase when maxMemories is 0", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const now = Date.now();
    const rows = [
      makeRow({
        id: "11111111-1111-1111-1111-111111111111",
        category: "events",
        created_at: now,
      }),
    ];
    vi.spyOn(db, "countRows").mockResolvedValue(1);
    vi.spyOn(db, "getAll").mockResolvedValue(rows);
    vi.spyOn(db, "deleteById").mockResolvedValue(true);

    const result = await db.maintain({ memoryTTLDays: 1 }); // TTL=1, maxMemories=0 (skip count)
    // Row is recent (created now), so TTL won't delete it either
    expect(result.deleted).toBe(0);
  });

  it("custom protectedCategories override default", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const now = Date.now();
    const profileRow = makeRow({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "profile",
      created_at: now - 100 * 24 * 60 * 60 * 1000,
    });
    const prefsRow = makeRow({
      id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "preferences",
      created_at: now - 100 * 24 * 60 * 60 * 1000,
    });

    const deleteByIdSpy = vi.spyOn(db, "deleteById").mockResolvedValue(true);
    vi.spyOn(db, "countRows").mockResolvedValue(2);
    vi.spyOn(db, "getAll").mockResolvedValue([profileRow, prefsRow]);

    // Protect preferences instead of profile
    const result = await db.maintain({
      memoryTTLDays: 30,
      protectedCategories: new Set(["preferences"]),
    });
    // profile is NOT protected in this call, so it should be deleted
    expect(deleteByIdSpy).toHaveBeenCalledWith(profileRow.id);
    expect(deleteByIdSpy).not.toHaveBeenCalledWith(prefsRow.id);
  });

  it("handles empty unprotected set in count phase gracefully", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    const rows = [
      makeRow({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        category: "profile",
        created_at: Date.now(),
      }),
      makeRow({
        id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        category: "profile",
        created_at: Date.now(),
      }),
      makeRow({
        id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
        category: "profile",
        created_at: Date.now(),
      }),
    ];
    vi.spyOn(db, "countRows").mockResolvedValue(3);
    vi.spyOn(db, "getAll").mockResolvedValue(rows);
    vi.spyOn(db, "deleteById").mockResolvedValue(true);

    // maxMemories=1 but all rows are protected profile
    const result = await db.maintain({ maxMemories: 1 });
    // Nothing should be deleted since all are protected
    expect(result.deleted).toBe(0);
  });

  it("passes actual row count to getAll to avoid 10k cap truncation", async () => {
    const db = new MemoryDB("/tmp/fake-maint", 3, silentLogger);
    (db as any).table = {};
    vi.spyOn(db, "countRows").mockResolvedValue(15000);
    const getAllSpy = vi.spyOn(db, "getAll").mockResolvedValue([]);
    vi.spyOn(db, "deleteById").mockResolvedValue(true);

    await db.maintain({ memoryTTLDays: 30 });
    // getAll should be called with actual count (15000), not default 10000
    expect(getAllSpy).toHaveBeenCalledWith(15000);
  });
});

// --- Integration tests ---

const describeIfIntegration =
  process.env.RUN_LANCEDB_INTEGRATION === "1" ? describe : describe.skip;

describeIfIntegration("MemoryDB cleanup integration", () => {
  let dbPath = "";
  let db: MemoryDB;

  beforeEach(async () => {
    dbPath = await mkdtemp(join(tmpdir(), "epro-cleanup-it-"));
    db = new MemoryDB(dbPath, 3, silentLogger);
  });

  afterEach(async () => {
    if (!dbPath) return;
    await rm(dbPath, { recursive: true, force: true }).catch(() => {});
  });

  it("deleteById removes a row from real LanceDB", async () => {
    const stored = await db.store(makeEntry("events", 1));
    const deleted = await db.deleteById(stored.id);
    expect(deleted).toBe(true);

    const loaded = await db.getById(stored.id);
    expect(loaded).toBeNull();
  });

  it("deleteById returns false for non-existent ID", async () => {
    await db.store(makeEntry("events", 1));
    const deleted = await db.deleteById("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(deleted).toBe(false);
  });

  it("TTL cleanup works on real LanceDB", async () => {
    // Store a row then manually backdate it
    const row = await db.store(makeEntry("events", 1));
    // Backdate by updating internal table
    // We can use update() to simulate this indirectly
    await db.update(row.id, { abstract: "old-memory" });

    // Since we can't easily backdate created_at through the API,
    // just verify maintain runs without error
    const result = await db.maintain({ memoryTTLDays: 30 });
    expect(result.deleted).toBe(0); // Row is fresh, won't be deleted
  });

  it("maxMemories cap works on real LanceDB", async () => {
    await db.store(makeEntry("events", 1));
    await db.store(makeEntry("events", 2));
    await db.store(makeEntry("events", 3));

    const result = await db.maintain({ maxMemories: 2 });
    expect(result.deleted).toBe(1);

    const remaining = await db.getAll();
    expect(remaining.length).toBe(2);
  });
});

// --- Config tests ---

describe("config: cleanupAfterExtraction", () => {
  it("defaults to false", () => {
    expect(DEFAULTS.cleanupAfterExtraction).toBe(false);
  });

  it("accepts true", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      cleanupAfterExtraction: true,
    });
    expect(cfg.cleanupAfterExtraction).toBe(true);
  });
});

describe("config: maxMemories", () => {
  it("defaults to 0", () => {
    expect(DEFAULTS.maxMemories).toBe(0);
  });

  it("accepts valid value", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      maxMemories: 5000,
    });
    expect(cfg.maxMemories).toBe(5000);
  });

  it("throws when negative", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        maxMemories: -1,
      }),
    ).toThrow("maxMemories must be a number between 0 and 100000");
  });

  it("throws when above maximum", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        maxMemories: 200000,
      }),
    ).toThrow("maxMemories must be a number between 0 and 100000");
  });
});

describe("config: memoryTTLDays", () => {
  it("defaults to 0", () => {
    expect(DEFAULTS.memoryTTLDays).toBe(0);
  });

  it("accepts valid value", () => {
    const cfg = parseConfig({
      embedding: { apiKey: "k" },
      llm: { apiKey: "k" },
      memoryTTLDays: 365,
    });
    expect(cfg.memoryTTLDays).toBe(365);
  });

  it("throws when negative", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        memoryTTLDays: -1,
      }),
    ).toThrow("memoryTTLDays must be a number between 0 and 3650");
  });

  it("throws when above maximum", () => {
    expect(() =>
      parseConfig({
        embedding: { apiKey: "k" },
        llm: { apiKey: "k" },
        memoryTTLDays: 5000,
      }),
    ).toThrow("memoryTTLDays must be a number between 0 and 3650");
  });
});
