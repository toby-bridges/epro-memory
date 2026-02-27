/**
 * LanceDB operations for agent memories.
 * L0/L1/L2 tiered schema with category-filtered vector search.
 */

import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import {
  MEMORY_CATEGORIES,
  type AgentMemoryRow,
  type MemoryCategory,
  type PluginLogger,
} from "./types.js";
import { type DecayConfigType, DEFAULTS } from "./config.js";

const TABLE_NAME = "agent_memories";

// --- Input sanitization (CRITICAL: prevents LanceDB filter injection) ---
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CATEGORIES = new Set<string>(MEMORY_CATEGORIES);

export function assertCategory(value: string): void {
  if (!VALID_CATEGORIES.has(value)) {
    throw new Error(`Invalid memory category: ${value}`);
  }
}

export function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

function rowToEntry(row: Record<string, unknown>): AgentMemoryRow {
  return {
    id: row.id as string,
    category: row.category as MemoryCategory,
    abstract: row.abstract as string,
    overview: row.overview as string,
    content: row.content as string,
    vector: Array.from(row.vector as Iterable<number>),
    source_session: row.source_session as string,
    active_count: row.active_count as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

/**
 * Computes decay-adjusted score for memory search results.
 *
 * Formula:
 *   decayScore = vectorScore * timeDecay * activeBoost
 *
 * Where:
 *   - timeDecay = 2^(-ageDays / halfLifeDays)  (exponential decay)
 *   - activeBoost = 1 + activeWeight * log(1 + activeCount)  (logarithmic boost)
 *
 * @param vectorScore - Original similarity score from vector search (0-1)
 * @param createdAt - Memory creation timestamp in milliseconds
 * @param activeCount - Number of times this memory was activated/recalled
 * @param config - Decay configuration
 * @returns Decay-adjusted score
 */
export function computeDecayScore(
  vectorScore: number,
  createdAt: number,
  activeCount: number,
  config: Required<DecayConfigType>,
): number {
  if (!config.enabled) return vectorScore;

  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.pow(2, -ageDays / config.halfLifeDays);
  const activeBoost = 1 + config.activeWeight * Math.log(1 + activeCount);

  return vectorScore * timeDecay * activeBoost;
}

export type MemorySearchResult = {
  entry: AgentMemoryRow;
  score: number;
};

export type OptimizeResult = {
  compaction: { fragmentsRemoved: number; fragmentsAdded: number };
  prune: { bytesRemoved: number; oldVersionsRemoved: number };
};

export type MaintainResult = {
  deleted: number;
  reason: string;
};

export class MemoryDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private readonly decayConfig: Required<DecayConfigType>;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly logger: PluginLogger,
    decayConfig?: DecayConfigType,
  ) {
    // Merge provided config with defaults
    this.decayConfig = {
      enabled: decayConfig?.enabled ?? DEFAULTS.decay.enabled,
      halfLifeDays: decayConfig?.halfLifeDays ?? DEFAULTS.decay.halfLifeDays,
      activeWeight: decayConfig?.activeWeight ?? DEFAULTS.decay.activeWeight,
    };
  }

  /** Serialize all write operations to prevent concurrent read-modify-write races. */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);

      // Verify existing table's vector dimensions match configured dimensions
      const sample = await this.table.query().limit(1).toArray();
      if (sample.length > 0) {
        const existingDim = (sample[0].vector as number[]).length;
        if (existingDim !== this.vectorDim) {
          throw new Error(
            `epro-memory: vector dimension mismatch — DB has ${existingDim}-dim vectors ` +
              `but config expects ${this.vectorDim}. ` +
              `Change embedding.dimensions or delete the DB to recreate.`,
          );
        }
      }
    } else {
      // Create table with schema row then delete it
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          category: "patterns",
          abstract: "",
          overview: "",
          content: "",
          vector: new Array(this.vectorDim).fill(0),
          source_session: "",
          active_count: 0,
          created_at: 0,
          updated_at: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
      this.logger.info("epro-memory: created agent_memories table");
    }
  }

  async store(
    entry: Omit<
      AgentMemoryRow,
      "id" | "created_at" | "updated_at" | "active_count"
    >,
  ): Promise<AgentMemoryRow> {
    await this.ensureInit();

    // Validate vector dimensions before storing
    if (entry.vector.length !== this.vectorDim) {
      throw new Error(
        `epro-memory: vector dimension mismatch — got ${entry.vector.length}-dim vector ` +
          `but DB expects ${this.vectorDim}`,
      );
    }

    const now = Date.now();
    const row: AgentMemoryRow = {
      ...entry,
      id: randomUUID(),
      active_count: 0,
      created_at: now,
      updated_at: now,
    };
    await this.table!.add([row]);
    return row;
  }

  async search(
    vector: number[],
    limit: number = 5,
    minScore: number = 0.3,
    categoryFilter?: MemoryCategory,
    skipDecay?: boolean,
  ): Promise<MemorySearchResult[]> {
    await this.ensureInit();

    if (vector.length !== this.vectorDim) {
      throw new Error(
        `epro-memory: search vector dimension mismatch — got ${vector.length}-dim but DB expects ${this.vectorDim}`,
      );
    }

    // When decay is active, over-fetch to compensate for re-ranking
    const useDecay = !skipDecay && this.decayConfig.enabled;
    const fetchLimit = useDecay ? Math.max(limit * 3, 20) : limit;

    let query = this.table!.vectorSearch(vector).limit(fetchLimit);

    if (categoryFilter) {
      assertCategory(categoryFilter);
      query = query.where(`category = '${categoryFilter}'`);
    }

    const results = await query.toArray();

    return results
      .map((row) => {
        const distance = (row._distance as number) ?? 0;
        const vectorScore = 1 / (1 + distance);
        const entry = rowToEntry(row as Record<string, unknown>);

        const score = useDecay
          ? computeDecayScore(
              vectorScore,
              entry.created_at,
              entry.active_count,
              this.decayConfig,
            )
          : vectorScore;

        return { entry, score };
      })
      .sort((a, b) => b.score - a.score)
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  async findByCategory(
    category: MemoryCategory,
    limit: number = 100,
  ): Promise<AgentMemoryRow[]> {
    await this.ensureInit();
    assertCategory(category);
    const results = await this.table!.query()
      .where(`category = '${category}'`)
      .limit(limit)
      .toArray();

    return results.map((row) => rowToEntry(row as Record<string, unknown>));
  }

  async getById(id: string): Promise<AgentMemoryRow | null> {
    await this.ensureInit();
    assertUuid(id);
    const results = await this.table!.query()
      .where(`id = '${id}'`)
      .limit(1)
      .toArray();
    if (results.length === 0) return null;
    return rowToEntry(results[0] as Record<string, unknown>);
  }

  async update(id: string, fields: Partial<AgentMemoryRow>): Promise<void> {
    await this.ensureInit();
    assertUuid(id);
    await this.withWriteLock(async () => {
      const existing = await this.table!.query()
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();

      if (existing.length === 0) return;

      // Strip Arrow/Lance internal fields via rowToEntry before writing back
      const clean = rowToEntry(existing[0] as Record<string, unknown>);
      // Prevent callers from overwriting immutable fields
      const {
        id: _id,
        created_at: _ca,
        source_session: _ss,
        ...safeFields
      } = fields;
      const updated = { ...clean, ...safeFields, updated_at: Date.now() };
      // Delete then add with same ID; restore original on add failure
      await this.table!.delete(`id = '${id}'`);
      try {
        await this.table!.add([updated]);
      } catch (err) {
        await this.table!.add([clean]);
        throw err;
      }
    });
  }

  /**
   * Compact fragments and prune old versions.
   * Never throws — returns null on error.
   */
  async optimize(
    cleanupOlderThanDays: number = 7,
  ): Promise<OptimizeResult | null> {
    try {
      await this.ensureInit();
      const ms = cleanupOlderThanDays * 24 * 60 * 60 * 1000;
      const cleanupOlderThan = new Date(Date.now() - ms);
      const stats = await this.table!.optimize({ cleanupOlderThan });
      return {
        compaction: {
          fragmentsRemoved: stats.compaction.fragmentsRemoved,
          fragmentsAdded: stats.compaction.fragmentsAdded,
        },
        prune: {
          bytesRemoved: stats.prune.bytesRemoved,
          oldVersionsRemoved: stats.prune.oldVersionsRemoved,
        },
      };
    } catch (err) {
      this.logger.warn(`epro-memory: optimize failed: ${String(err)}`);
      return null;
    }
  }

  async countRows(): Promise<number> {
    await this.ensureInit();
    return this.table!.countRows();
  }

  /**
   * Create bitmap index on category (always) and IVF_PQ vector index when
   * row count >= threshold. Skips indices that already exist. Never throws.
   */
  async ensureIndices(vectorIndexThreshold: number = 1000): Promise<void> {
    try {
      await this.ensureInit();
      const existing = await this.table!.listIndices();
      const existingColumns = new Set(existing.flatMap((idx) => idx.columns));

      // Bitmap index on category (always, cheap)
      if (!existingColumns.has("category")) {
        await this.table!.createIndex("category", {
          config: Index.bitmap(),
        });
        this.logger.info("epro-memory: created bitmap index on category");
      }

      // IVF_PQ vector index when rows >= threshold
      if (!existingColumns.has("vector")) {
        const rows = await this.table!.countRows();
        if (rows >= vectorIndexThreshold) {
          const numPartitions = Math.max(1, Math.floor(Math.sqrt(rows)));
          await this.table!.createIndex("vector", {
            config: Index.ivfPq({ numPartitions }),
          });
          this.logger.info(
            `epro-memory: created IVF_PQ vector index (${rows} rows, ${numPartitions} partitions)`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`epro-memory: ensureIndices failed: ${String(err)}`);
    }
  }

  /**
   * Delete a single memory by ID. Uses write lock. Validates UUID.
   * Returns true if a row was deleted, false if not found.
   */
  async deleteById(id: string): Promise<boolean> {
    await this.ensureInit();
    assertUuid(id);
    return this.withWriteLock(async () => {
      const existing = await this.table!.query()
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();
      if (existing.length === 0) return false;
      await this.table!.delete(`id = '${id}'`);
      return true;
    });
  }

  /**
   * Two-phase lifecycle maintenance:
   * 1. TTL phase: delete memories older than memoryTTLDays (adjusted by active_count)
   * 2. Count phase: if over maxMemories, delete lowest-scored memories
   *
   * Profile memories are never auto-deleted (protected by default).
   */
  async maintain(options: {
    maxMemories?: number;
    memoryTTLDays?: number;
    protectedCategories?: Set<MemoryCategory>;
  }): Promise<MaintainResult> {
    await this.ensureInit();
    const {
      maxMemories = 0,
      memoryTTLDays = 0,
      protectedCategories = new Set<MemoryCategory>(["profile"]),
    } = options;

    let deleted = 0;
    const reasons: string[] = [];
    const now = Date.now();

    // Use actual row count for accurate decisions (not capped by getAll limit)
    const totalRowCount = await this.countRows();

    // Phase 1: TTL-based cleanup
    if (memoryTTLDays > 0) {
      const allRows = await this.getAll(totalRowCount);
      const baseTTLMs = memoryTTLDays * 24 * 60 * 60 * 1000;

      for (const row of allRows) {
        if (protectedCategories.has(row.category)) continue;
        // Active memories get proportionally longer grace period
        const adjustedTTLMs = baseTTLMs * (1 + row.active_count / 10);
        const age = now - row.created_at;
        if (age > adjustedTTLMs) {
          await this.deleteById(row.id);
          deleted++;
        }
      }
      if (deleted > 0) {
        reasons.push(`ttl: ${deleted} expired`);
      }
    }

    // Phase 2: Count-based cleanup
    if (maxMemories > 0) {
      const currentCount = deleted > 0 ? await this.countRows() : totalRowCount;
      const remaining = await this.getAll(currentCount);
      const unprotected = remaining.filter(
        (row) => !protectedCategories.has(row.category),
      );
      const total = remaining.length;

      if (total > maxMemories) {
        const excess = total - maxMemories;
        // Score by active_count + recency_bonus(0-10)
        const oldest = Math.min(...unprotected.map((r) => r.created_at));
        const newest = Math.max(...unprotected.map((r) => r.created_at));
        const timeRange = newest - oldest || 1;

        const scored = unprotected.map((row) => {
          const recencyBonus = ((row.created_at - oldest) / timeRange) * 10;
          return { row, score: row.active_count + recencyBonus };
        });
        scored.sort((a, b) => a.score - b.score);

        const toDelete = scored.slice(0, excess);
        let countDeleted = 0;
        for (const { row } of toDelete) {
          await this.deleteById(row.id);
          countDeleted++;
        }
        deleted += countDeleted;
        if (countDeleted > 0) {
          reasons.push(`count: ${countDeleted} over limit`);
        }
      }
    }

    return {
      deleted,
      reason: reasons.length > 0 ? reasons.join("; ") : "no cleanup needed",
    };
  }

  async incrementActiveCount(id: string): Promise<void> {
    await this.ensureInit();
    assertUuid(id);
    await this.withWriteLock(async () => {
      const existing = await this.table!.query()
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();

      if (existing.length === 0) return;

      // Strip Arrow/Lance internal fields via rowToEntry before writing back
      const clean = rowToEntry(existing[0] as Record<string, unknown>);
      const updated = {
        ...clean,
        active_count: (clean.active_count || 0) + 1,
        updated_at: Date.now(),
      };
      // Delete then add with same ID; restore original on add failure
      await this.table!.delete(`id = '${id}'`);
      try {
        await this.table!.add([updated]);
      } catch (err) {
        await this.table!.add([clean]);
        throw err;
      }
    });
  }

  /**
   * Get all memories from the database.
   * Used by QMD projection to generate daily summaries.
   *
   * @param maxLimit - Maximum number of records to return (default: 10000)
   * @returns Array of all memory entries
   */
  async getAll(maxLimit: number = 10000): Promise<AgentMemoryRow[]> {
    await this.ensureInit();
    const results = await this.table!.query().limit(maxLimit).toArray();
    return results.map((row) => rowToEntry(row as Record<string, unknown>));
  }
}
