import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../sqlite-store.js";
import type { MemoryCategory, PluginLogger } from "../types.js";

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

describe("SQLiteStore", () => {
  let store: SQLiteStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "epro-sqlite-test-"));
    store = new SQLiteStore(join(tmpDir, "test.db"), 3, silentLogger);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --- CRUD ---

  it("store and getById", async () => {
    const row = await store.store(makeEntry("events", 1));
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(row.category).toBe("events");
    expect(row.active_count).toBe(0);
    expect(row.created_at).toBeGreaterThan(0);

    const found = await store.getById(row.id);
    expect(found).not.toBeNull();
    expect(found!.abstract).toBe("events-abstract-1");
    expect(found!.vector).toEqual([1, 1.100000023841858, 1.2000000476837158]); // Float32 precision
  });

  it("getById returns null for missing ID", async () => {
    const found = await store.getById("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(found).toBeNull();
  });

  it("update modifies fields", async () => {
    const row = await store.store(makeEntry("events", 1));
    await store.update(row.id, {
      abstract: "updated abstract",
      content: "updated content",
    });

    const updated = await store.getById(row.id);
    expect(updated!.abstract).toBe("updated abstract");
    expect(updated!.content).toBe("updated content");
    expect(updated!.updated_at).toBeGreaterThanOrEqual(row.updated_at);
    // Immutable fields should not change
    expect(updated!.created_at).toBe(row.created_at);
    expect(updated!.source_session).toBe(row.source_session);
  });

  it("update with vector updates vector table", async () => {
    const row = await store.store(makeEntry("events", 1));
    await store.update(row.id, { vector: [9, 9.1, 9.2] });

    const updated = await store.getById(row.id);
    // Float32 precision
    expect(updated!.vector[0]).toBeCloseTo(9, 1);
  });

  it("deleteById removes row and returns true", async () => {
    const row = await store.store(makeEntry("events", 1));
    const deleted = await store.deleteById(row.id);
    expect(deleted).toBe(true);

    const found = await store.getById(row.id);
    expect(found).toBeNull();
  });

  it("deleteById returns false for missing ID", async () => {
    const deleted = await store.deleteById(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(deleted).toBe(false);
  });

  // --- Search ---

  it("search returns results sorted by score", async () => {
    await store.store(makeEntry("events", 1)); // vector [1, 1.1, 1.2]
    await store.store(makeEntry("events", 5)); // vector [5, 5.1, 5.2]

    const results = await store.search([1, 1.1, 1.2], 5, 0.1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(results[results.length - 1].score);
  });

  it("search respects category filter", async () => {
    await store.store(makeEntry("events", 1));
    await store.store(makeEntry("patterns", 2));

    const results = await store.search([1, 1.1, 1.2], 5, 0.01, "patterns");
    for (const r of results) {
      expect(r.entry.category).toBe("patterns");
    }
  });

  it("search category filter is not truncated by global top-K", async () => {
    // Regression: category filter must be pushed into KNN, not applied post-KNN.
    // If post-KNN, the target category gets crowded out by closer other-category vectors.
    const targetVec = [1, 1.1, 1.2];

    // Insert 1 target-category memory with exact vector match
    await store.store({
      category: "patterns",
      abstract: "target",
      overview: "o",
      content: "c",
      vector: targetVec,
      source_session: "s",
    });

    // Flood with 20 closer other-category memories (same vector = distance 0)
    for (let i = 0; i < 20; i++) {
      await store.store({
        category: "events",
        abstract: `flood-${i}`,
        overview: "o",
        content: "c",
        vector: targetVec,
        source_session: "s",
      });
    }

    // Search for "patterns" with limit=5 — must find the 1 target
    const results = await store.search(targetVec, 5, 0.01, "patterns");
    expect(results.length).toBe(1);
    expect(results[0].entry.category).toBe("patterns");
    expect(results[0].entry.abstract).toBe("target");
  });

  it("search category filter can fill limit within target category", async () => {
    // Even with heavy cross-category crowding, limit should apply inside category.
    const targetVec = [1, 1.1, 1.2];

    for (let i = 0; i < 6; i++) {
      await store.store({
        category: "patterns",
        abstract: `pattern-${i}`,
        overview: "o",
        content: "c",
        vector: targetVec,
        source_session: "s",
      });
    }

    for (let i = 0; i < 30; i++) {
      await store.store({
        category: "events",
        abstract: `event-${i}`,
        overview: "o",
        content: "c",
        vector: targetVec,
        source_session: "s",
      });
    }

    const results = await store.search(targetVec, 5, 0.01, "patterns");
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.entry.category === "patterns")).toBe(true);
  });

  it("search respects minScore filter", async () => {
    await store.store(makeEntry("events", 1));
    await store.store(makeEntry("events", 100));

    const results = await store.search([1, 1.1, 1.2], 5, 0.99);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("search respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await store.store(makeEntry("events", i));
    }

    const results = await store.search([1, 1.1, 1.2], 3, 0.01);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("search throws on dimension mismatch", async () => {
    await expect(
      store.search([1, 2], 5, 0.3), // 2-dim vs 3-dim
    ).rejects.toThrow("vector dimension mismatch");
  });

  // --- findByCategory ---

  it("findByCategory returns matching rows", async () => {
    await store.store(makeEntry("events", 1));
    await store.store(makeEntry("patterns", 2));
    await store.store(makeEntry("events", 3));

    const events = await store.findByCategory("events");
    expect(events.length).toBe(2);
    expect(events.every((e) => e.category === "events")).toBe(true);
  });

  it("findByCategory respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.store(makeEntry("events", i));
    }

    const events = await store.findByCategory("events", 2);
    expect(events.length).toBe(2);
  });

  // --- getAll / countRows ---

  it("getAll returns all rows", async () => {
    await store.store(makeEntry("events", 1));
    await store.store(makeEntry("patterns", 2));

    const all = await store.getAll();
    expect(all.length).toBe(2);
  });

  it("countRows returns correct count", async () => {
    expect(await store.countRows()).toBe(0);

    await store.store(makeEntry("events", 1));
    expect(await store.countRows()).toBe(1);

    await store.store(makeEntry("patterns", 2));
    expect(await store.countRows()).toBe(2);
  });

  // --- incrementActiveCount ---

  it("incrementActiveCount increases count", async () => {
    const row = await store.store(makeEntry("events", 1));
    expect(row.active_count).toBe(0);

    await store.incrementActiveCount(row.id);
    const updated = await store.getById(row.id);
    expect(updated!.active_count).toBe(1);

    await store.incrementActiveCount(row.id);
    const updated2 = await store.getById(row.id);
    expect(updated2!.active_count).toBe(2);
  });

  // --- maintain ---

  it("maintain deletes expired TTL memories", async () => {
    // Mock Date.now so the memory appears old relative to "now"
    const realNow = Date.now();
    const row = await store.store(makeEntry("events", 1));

    // Advance time by 31 days for the maintain check
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(realNow + 31 * 24 * 60 * 60 * 1000);
    const result = await store.maintain({ memoryTTLDays: 30 });
    spy.mockRestore();

    expect(result.deleted).toBe(1);
    expect(result.reason).toContain("ttl");
  });

  it("maintain respects maxMemories", async () => {
    for (let i = 0; i < 5; i++) {
      await store.store(makeEntry("events", i));
    }

    const result = await store.maintain({ maxMemories: 3 });
    expect(result.deleted).toBe(2);
    expect(result.reason).toContain("count");

    const remaining = await store.countRows();
    expect(remaining).toBe(3);
  });

  it("maintain protects profile category by default", async () => {
    const profile = await store.store(makeEntry("profile", 1));
    await store.store(makeEntry("events", 2));

    const result = await store.maintain({ maxMemories: 1 });
    // Profile is protected, only events should be deleted
    const found = await store.getById(profile.id);
    expect(found).not.toBeNull();
  });

  it("maintain returns no-cleanup when nothing to do", async () => {
    const result = await store.maintain({});
    expect(result.deleted).toBe(0);
    expect(result.reason).toBe("no cleanup needed");
  });

  // --- optimize ---

  it("optimize runs VACUUM without error", async () => {
    await store.store(makeEntry("events", 1));
    const result = await store.optimize();
    expect(result).not.toBeNull();
  });

  // --- ensureIndices ---

  it("ensureIndices is a no-op", async () => {
    // Should not throw
    await store.ensureIndices();
  });

  // --- store validates vector dimensions ---

  it("store throws on dimension mismatch", async () => {
    const entry = makeEntry("events", 1);
    entry.vector = [1, 2]; // 2-dim vs 3-dim
    await expect(store.store(entry)).rejects.toThrow(
      "vector dimension mismatch",
    );
  });

  // --- init creates directory ---

  it("init creates parent directory if missing", async () => {
    const nestedStore = new SQLiteStore(
      join(tmpDir, "nested", "deep", "test.db"),
      3,
      silentLogger,
    );
    await nestedStore.init();
    const count = await nestedStore.countRows();
    expect(count).toBe(0);
    await nestedStore.close();
  });

  // --- close and reinit ---

  it("can close and reinit", async () => {
    await store.store(makeEntry("events", 1));
    await store.close();

    // Reinitialize same store
    store = new SQLiteStore(join(tmpDir, "test.db"), 3, silentLogger);
    await store.init();

    const count = await store.countRows();
    expect(count).toBe(1);
  });

  // --- Decay integration ---

  it("search with decay enabled", async () => {
    const decayStore = new SQLiteStore(
      join(tmpDir, "decay-test.db"),
      3,
      silentLogger,
      { enabled: true, halfLifeDays: 30, activeWeight: 0.1 },
    );
    await decayStore.init();

    await decayStore.store(makeEntry("events", 1));
    const results = await decayStore.search([1, 1.1, 1.2], 5, 0.01);
    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);

    await decayStore.close();
  });
});
