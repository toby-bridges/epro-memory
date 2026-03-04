/**
 * Backend compatibility tests.
 * Verifies SQLiteStore and LanceDBStore produce equivalent results
 * for the same operations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../sqlite-store.js";
import { LanceDBStore } from "../lancedb-store.js";
import type { MemoryCategory, MemoryStore, PluginLogger } from "../types.js";

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
    vector: [n * 0.1, n * 0.2, n * 0.3],
    source_session: `session-${n}`,
  };
}

const describeIfIntegration =
  process.env.RUN_LANCEDB_INTEGRATION === "1" ? describe : describe.skip;

describeIfIntegration("Backend compatibility (SQLite vs LanceDB)", () => {
  let sqliteStore: SQLiteStore;
  let lanceStore: LanceDBStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "epro-compat-test-"));
    sqliteStore = new SQLiteStore(join(tmpDir, "sqlite.db"), 3, silentLogger);
    lanceStore = new LanceDBStore(join(tmpDir, "lancedb"), 3, silentLogger);
    await sqliteStore.init();
    await lanceStore.init();
  });

  afterEach(async () => {
    await sqliteStore.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runOnBoth<T>(
    fn: (store: MemoryStore) => Promise<T>,
  ): Promise<[T, T]> {
    return [await fn(sqliteStore), await fn(lanceStore)];
  }

  it("store creates rows with same structure", async () => {
    const entry = makeEntry("events", 1);
    const [sqliteRow, lanceRow] = await runOnBoth((s) => s.store(entry));

    // Same fields present
    expect(sqliteRow.category).toBe(lanceRow.category);
    expect(sqliteRow.abstract).toBe(lanceRow.abstract);
    expect(sqliteRow.overview).toBe(lanceRow.overview);
    expect(sqliteRow.content).toBe(lanceRow.content);
    expect(sqliteRow.source_session).toBe(lanceRow.source_session);
    expect(sqliteRow.active_count).toBe(lanceRow.active_count);
    // IDs differ (both UUID format)
    expect(sqliteRow.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(lanceRow.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("countRows returns same count after same operations", async () => {
    const entry1 = makeEntry("events", 1);
    const entry2 = makeEntry("patterns", 2);

    await runOnBoth((s) => s.store(entry1));
    await runOnBoth((s) => s.store(entry2));

    const [sqliteCount, lanceCount] = await runOnBoth((s) => s.countRows());
    expect(sqliteCount).toBe(lanceCount);
    expect(sqliteCount).toBe(2);
  });

  it("getById returns same data after store", async () => {
    const entry = makeEntry("events", 1);
    const sqliteRow = await sqliteStore.store(entry);
    const lanceRow = await lanceStore.store(entry);

    const sqliteFound = await sqliteStore.getById(sqliteRow.id);
    const lanceFound = await lanceStore.getById(lanceRow.id);

    expect(sqliteFound).not.toBeNull();
    expect(lanceFound).not.toBeNull();
    expect(sqliteFound!.category).toBe(lanceFound!.category);
    expect(sqliteFound!.abstract).toBe(lanceFound!.abstract);
    expect(sqliteFound!.content).toBe(lanceFound!.content);
  });

  it("deleteById returns same result", async () => {
    const entry = makeEntry("events", 1);
    const sqliteRow = await sqliteStore.store(entry);
    const lanceRow = await lanceStore.store(entry);

    const [sqliteDel, lanceDel] = [
      await sqliteStore.deleteById(sqliteRow.id),
      await lanceStore.deleteById(lanceRow.id),
    ];
    expect(sqliteDel).toBe(lanceDel);
    expect(sqliteDel).toBe(true);

    // Verify both return false for already deleted
    const [sqliteDel2, lanceDel2] = [
      await sqliteStore.deleteById(sqliteRow.id),
      await lanceStore.deleteById(lanceRow.id),
    ];
    expect(sqliteDel2).toBe(lanceDel2);
    expect(sqliteDel2).toBe(false);
  });

  it("findByCategory returns same categories", async () => {
    await runOnBoth((s) => s.store(makeEntry("events", 1)));
    await runOnBoth((s) => s.store(makeEntry("patterns", 2)));
    await runOnBoth((s) => s.store(makeEntry("events", 3)));

    const [sqliteEvents, lanceEvents] = await runOnBoth((s) =>
      s.findByCategory("events"),
    );
    expect(sqliteEvents.length).toBe(lanceEvents.length);
    expect(sqliteEvents.length).toBe(2);
  });

  it("search returns results with comparable ordering", async () => {
    // Store same entries in both
    for (let i = 1; i <= 5; i++) {
      await runOnBoth((s) => s.store(makeEntry("events", i)));
    }

    const queryVec = [0.1, 0.2, 0.3]; // matches entry 1
    const [sqliteResults, lanceResults] = await runOnBoth((s) =>
      s.search(queryVec, 3, 0.01),
    );

    // Both should return results
    expect(sqliteResults.length).toBeGreaterThan(0);
    expect(lanceResults.length).toBeGreaterThan(0);

    // Top result should be the closest vector (entry 1)
    expect(sqliteResults[0].entry.abstract).toContain("-1");
    expect(lanceResults[0].entry.abstract).toContain("-1");
  });

  it("incrementActiveCount works identically", async () => {
    const sqliteRow = await sqliteStore.store(makeEntry("events", 1));
    const lanceRow = await lanceStore.store(makeEntry("events", 1));

    await sqliteStore.incrementActiveCount(sqliteRow.id);
    await lanceStore.incrementActiveCount(lanceRow.id);

    const sqliteUpdated = await sqliteStore.getById(sqliteRow.id);
    const lanceUpdated = await lanceStore.getById(lanceRow.id);

    expect(sqliteUpdated!.active_count).toBe(lanceUpdated!.active_count);
    expect(sqliteUpdated!.active_count).toBe(1);
  });

  it("update modifies same fields", async () => {
    const sqliteRow = await sqliteStore.store(makeEntry("events", 1));
    const lanceRow = await lanceStore.store(makeEntry("events", 1));

    const updates = { abstract: "updated", content: "new content" };
    await sqliteStore.update(sqliteRow.id, updates);
    await lanceStore.update(lanceRow.id, updates);

    const sqliteUpdated = await sqliteStore.getById(sqliteRow.id);
    const lanceUpdated = await lanceStore.getById(lanceRow.id);

    expect(sqliteUpdated!.abstract).toBe(lanceUpdated!.abstract);
    expect(sqliteUpdated!.content).toBe(lanceUpdated!.content);
    expect(sqliteUpdated!.abstract).toBe("updated");
  });

  it("getAll returns same count", async () => {
    for (let i = 0; i < 5; i++) {
      await runOnBoth((s) => s.store(makeEntry("events", i)));
    }

    const [sqliteAll, lanceAll] = await runOnBoth((s) => s.getAll());
    expect(sqliteAll.length).toBe(lanceAll.length);
    expect(sqliteAll.length).toBe(5);
  });

  it("maintain produces same deletion counts", async () => {
    for (let i = 0; i < 5; i++) {
      await runOnBoth((s) => s.store(makeEntry("events", i)));
    }

    const [sqliteResult, lanceResult] = await runOnBoth((s) =>
      s.maintain({ maxMemories: 3 }),
    );
    expect(sqliteResult.deleted).toBe(lanceResult.deleted);
    expect(sqliteResult.deleted).toBe(2);
  });
});
