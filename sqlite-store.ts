/**
 * SQLite + sqlite-vec backend for agent memories.
 * Explicit columns matching LanceDB schema 1:1 for behavioral parity.
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentMemoryRow,
  MaintainOptions,
  MaintainResult,
  MemoryCategory,
  MemorySearchResult,
  MemoryStore,
  OptimizeResult,
  PluginLogger,
} from "./types.js";
import { type DecayConfigType, DEFAULTS } from "./config.js";
import { assertCategory, assertUuid, computeDecayScore } from "./utils.js";

/** Convert a number[] vector to a Buffer for sqlite-vec binding. */
function vecToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** Convert a sqlite-vec Buffer result back to number[]. */
function bufferToVec(buf: Buffer): number[] {
  const floats = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  return Array.from(floats);
}

export class SQLiteStore implements MemoryStore {
  private db: BetterSqlite3.Database | null = null;
  private readonly decayConfig: Required<DecayConfigType>;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly logger: PluginLogger,
    decayConfig?: DecayConfigType,
  ) {
    this.decayConfig = {
      enabled: decayConfig?.enabled ?? DEFAULTS.decay.enabled,
      halfLifeDays: decayConfig?.halfLifeDays ?? DEFAULTS.decay.halfLifeDays,
      activeWeight: decayConfig?.activeWeight ?? DEFAULTS.decay.activeWeight,
    };
  }

  async init(): Promise<void> {
    if (this.db) return;

    // Ensure parent directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    sqliteVec.load(this.db);

    // Enable WAL for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    // Create memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        abstract TEXT NOT NULL,
        overview TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session TEXT NOT NULL,
        active_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create indices
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_category ON agent_memories(category);
      CREATE INDEX IF NOT EXISTS idx_created_at ON agent_memories(created_at);
    `);

    // Create vector table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_vectors
      USING vec0(id TEXT PRIMARY KEY, embedding float[${this.vectorDim}])
    `);

    this.logger.info("epro-memory: SQLite store initialized");
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): BetterSqlite3.Database {
    if (!this.db)
      throw new Error("SQLiteStore not initialized. Call init() first.");
    return this.db;
  }

  async store(
    entry: Omit<
      AgentMemoryRow,
      "id" | "created_at" | "updated_at" | "active_count"
    >,
  ): Promise<AgentMemoryRow> {
    const db = this.ensureDb();

    if (entry.vector.length !== this.vectorDim) {
      throw new Error(
        `epro-memory: vector dimension mismatch — got ${entry.vector.length}-dim vector ` +
          `but DB expects ${this.vectorDim}`,
      );
    }

    const now = Date.now();
    const id = randomUUID();
    const row: AgentMemoryRow = {
      ...entry,
      id,
      active_count: 0,
      created_at: now,
      updated_at: now,
    };

    const txn = db.transaction(() => {
      db.prepare(
        `
        INSERT INTO agent_memories (id, category, abstract, overview, content, source_session, active_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        row.id,
        row.category,
        row.abstract,
        row.overview,
        row.content,
        row.source_session,
        row.active_count,
        row.created_at,
        row.updated_at,
      );

      db.prepare(
        `
        INSERT INTO agent_memory_vectors (id, embedding) VALUES (?, ?)
      `,
      ).run(row.id, vecToBuffer(row.vector));
    });
    txn();

    return row;
  }

  async getById(id: string): Promise<AgentMemoryRow | null> {
    const db = this.ensureDb();
    assertUuid(id);

    const row = db
      .prepare(
        `
      SELECT m.*, v.embedding FROM agent_memories m
      LEFT JOIN agent_memory_vectors v ON m.id = v.id
      WHERE m.id = ?
    `,
      )
      .get(id) as
      | (Record<string, unknown> & { embedding?: Buffer })
      | undefined;

    if (!row) return null;
    return this.rowToEntry(row);
  }

  async update(id: string, fields: Partial<AgentMemoryRow>): Promise<void> {
    const db = this.ensureDb();
    assertUuid(id);

    const existing = await this.getById(id);
    if (!existing) return;

    // Prevent callers from overwriting immutable fields
    const {
      id: _id,
      created_at: _ca,
      source_session: _ss,
      ...safeFields
    } = fields;

    const updated = { ...existing, ...safeFields, updated_at: Date.now() };

    const txn = db.transaction(() => {
      db.prepare(
        `
        UPDATE agent_memories SET
          category = ?, abstract = ?, overview = ?, content = ?,
          active_count = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run(
        updated.category,
        updated.abstract,
        updated.overview,
        updated.content,
        updated.active_count,
        updated.updated_at,
        id,
      );

      if (fields.vector) {
        db.prepare(`DELETE FROM agent_memory_vectors WHERE id = ?`).run(id);
        db.prepare(
          `INSERT INTO agent_memory_vectors (id, embedding) VALUES (?, ?)`,
        ).run(id, vecToBuffer(updated.vector));
      }
    });
    txn();
  }

  async deleteById(id: string): Promise<boolean> {
    const db = this.ensureDb();
    assertUuid(id);

    const txn = db.transaction(() => {
      const result = db
        .prepare(`DELETE FROM agent_memories WHERE id = ?`)
        .run(id);
      db.prepare(`DELETE FROM agent_memory_vectors WHERE id = ?`).run(id);
      return result.changes > 0;
    });
    return txn();
  }

  async search(
    vector: number[],
    limit: number = 5,
    minScore: number = 0.3,
    categoryFilter?: MemoryCategory,
    skipDecay?: boolean,
  ): Promise<MemorySearchResult[]> {
    const db = this.ensureDb();

    if (vector.length !== this.vectorDim) {
      throw new Error(
        `epro-memory: search vector dimension mismatch — got ${vector.length}-dim but DB expects ${this.vectorDim}`,
      );
    }

    const useDecay = !skipDecay && this.decayConfig.enabled;
    const fetchLimit = useDecay ? Math.max(limit * 3, 20) : limit;

    // Validate category early (before entering transaction)
    if (categoryFilter) assertCategory(categoryFilter);

    // Wrap in deferred transaction for read consistency
    const txn = db.transaction(() => {
      // sqlite-vec KNN search — push category filter into WHERE clause
      // so KNN only considers rows in the target category
      let vecResults: Array<{ id: string; distance: number }>;
      if (categoryFilter) {
        vecResults = db
          .prepare(
            `
          SELECT id, distance FROM agent_memory_vectors
          WHERE embedding MATCH ?
            AND id IN (SELECT id FROM agent_memories WHERE category = ?)
          ORDER BY distance
          LIMIT ?
        `,
          )
          .all(vecToBuffer(vector), categoryFilter, fetchLimit) as Array<{
          id: string;
          distance: number;
        }>;
      } else {
        vecResults = db
          .prepare(
            `
          SELECT id, distance FROM agent_memory_vectors
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
        `,
          )
          .all(vecToBuffer(vector), fetchLimit) as Array<{
          id: string;
          distance: number;
        }>;
      }

      if (vecResults.length === 0) return [];

      // Fetch full rows + vectors in a single JOIN (avoids N+1)
      const ids = vecResults.map((r) => r.id);
      // Safe: placeholders generated programmatically, IDs use parameter binding
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `
        SELECT m.*, v.embedding FROM agent_memories m
        LEFT JOIN agent_memory_vectors v ON m.id = v.id
        WHERE m.id IN (${placeholders})
      `,
        )
        .all(...ids) as Array<Record<string, unknown> & { embedding?: Buffer }>;

      const rowMap = new Map<
        string,
        Record<string, unknown> & { embedding?: Buffer }
      >();
      for (const row of rows) {
        rowMap.set(row.id as string, row);
      }

      // Build results with scores
      const results: MemorySearchResult[] = [];
      for (const vr of vecResults) {
        const row = rowMap.get(vr.id);
        if (!row) continue;

        const vectorScore = 1 / (1 + vr.distance);
        const entry = this.rowToEntry(row);

        const score = useDecay
          ? computeDecayScore(
              vectorScore,
              entry.created_at,
              entry.active_count,
              this.decayConfig,
            )
          : vectorScore;

        results.push({ entry, score });
      }

      return results
        .sort((a, b) => b.score - a.score)
        .filter((r) => r.score >= minScore)
        .slice(0, limit);
    });

    return txn();
  }

  async findByCategory(
    category: MemoryCategory,
    limit: number = 100,
  ): Promise<AgentMemoryRow[]> {
    const db = this.ensureDb();
    assertCategory(category);

    const rows = db
      .prepare(
        `
      SELECT m.*, v.embedding FROM agent_memories m
      LEFT JOIN agent_memory_vectors v ON m.id = v.id
      WHERE m.category = ?
      LIMIT ?
    `,
      )
      .all(category, limit) as Array<
      Record<string, unknown> & { embedding?: Buffer }
    >;

    return rows.map((row) => this.rowToEntry(row));
  }

  async getAll(maxLimit: number = 10000): Promise<AgentMemoryRow[]> {
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `
      SELECT m.*, v.embedding FROM agent_memories m
      LEFT JOIN agent_memory_vectors v ON m.id = v.id
      LIMIT ?
    `,
      )
      .all(maxLimit) as Array<Record<string, unknown> & { embedding?: Buffer }>;

    return rows.map((row) => this.rowToEntry(row));
  }

  async countRows(): Promise<number> {
    const db = this.ensureDb();
    const result = db
      .prepare(`SELECT COUNT(*) as count FROM agent_memories`)
      .get() as { count: number };
    return result.count;
  }

  async incrementActiveCount(id: string): Promise<void> {
    const db = this.ensureDb();
    assertUuid(id);

    db.prepare(
      `
      UPDATE agent_memories SET active_count = active_count + 1, updated_at = ? WHERE id = ?
    `,
    ).run(Date.now(), id);
  }

  async maintain(options: MaintainOptions): Promise<MaintainResult> {
    const db = this.ensureDb();
    const {
      maxMemories = 0,
      memoryTTLDays = 0,
      protectedCategories = new Set<MemoryCategory>(["profile"]),
    } = options;

    let deleted = 0;
    const reasons: string[] = [];
    const now = Date.now();

    const totalRowCount = await this.countRows();

    // Phase 1: TTL-based cleanup
    if (memoryTTLDays > 0) {
      const allRows = await this.getAll(totalRowCount);
      const baseTTLMs = memoryTTLDays * 24 * 60 * 60 * 1000;

      for (const row of allRows) {
        if (protectedCategories.has(row.category)) continue;
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

  async optimize(): Promise<OptimizeResult | null> {
    try {
      const db = this.ensureDb();
      db.exec("VACUUM");
      return {
        compaction: { fragmentsRemoved: 0, fragmentsAdded: 0 },
        prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
      };
    } catch (err) {
      this.logger.warn(`epro-memory: optimize (VACUUM) failed: ${String(err)}`);
      return null;
    }
  }

  async ensureIndices(): Promise<void> {
    // Indices are created at init time; this is a no-op for SQLite
  }

  private rowToEntry(
    row: Record<string, unknown> & { embedding?: Buffer },
  ): AgentMemoryRow {
    return {
      id: row.id as string,
      category: row.category as MemoryCategory,
      abstract: row.abstract as string,
      overview: row.overview as string,
      content: row.content as string,
      vector: row.embedding ? bufferToVec(row.embedding) : [],
      source_session: row.source_session as string,
      active_count: row.active_count as number,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }
}
