/**
 * Shared types for ePro memory plugin.
 *
 * 6-category classification from OpenViking:
 * - UserMemory: profile, preferences, entities, events
 * - AgentMemory: cases, patterns
 */

export const MEMORY_CATEGORIES = [
  "profile",
  "preferences",
  "entities",
  "events",
  "cases",
  "patterns",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Categories that always merge (skip dedup). */
export const ALWAYS_MERGE_CATEGORIES = new Set<MemoryCategory>(["profile"]);

/** Categories that support MERGE decision from LLM dedup. */
export const MERGE_SUPPORTED_CATEGORIES = new Set<MemoryCategory>([
  "preferences",
  "entities",
  "patterns",
]);

/** A candidate memory extracted from conversation by LLM. */
export type CandidateMemory = {
  category: MemoryCategory;
  abstract: string; // L0
  overview: string; // L1
  content: string; // L2
};

/** A row in the LanceDB agent_memories table. */
export type AgentMemoryRow = {
  id: string;
  category: MemoryCategory;
  abstract: string;
  overview: string;
  content: string;
  vector: number[];
  source_session: string;
  active_count: number;
  created_at: number;
  updated_at: number;
};

/** Dedup decision from LLM. */
export type DedupDecision = "create" | "merge" | "skip";

export type DedupResult = {
  decision: DedupDecision;
  reason: string;
  matchId?: string; // ID of existing memory to merge with
};

export type ExtractionStats = {
  created: number;
  merged: number;
  skipped: number;
};

export type PluginLogger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type MemorySearchResult = {
  entry: AgentMemoryRow;
  score: number;
};

export type OptimizeResult = {
  compaction: { fragmentsRemoved: number; fragmentsAdded: number };
  prune: { bytesRemoved: number; oldVersionsRemoved: number };
};

export type MaintainOptions = {
  maxMemories?: number;
  memoryTTLDays?: number;
  protectedCategories?: Set<MemoryCategory>;
};

export type MaintainResult = {
  deleted: number;
  reason: string;
};

export interface MemoryStore {
  init(): Promise<void>;
  close?(): Promise<void>;
  store(
    entry: Omit<
      AgentMemoryRow,
      "id" | "created_at" | "updated_at" | "active_count"
    >,
  ): Promise<AgentMemoryRow>;
  getById(id: string): Promise<AgentMemoryRow | null>;
  update(id: string, fields: Partial<AgentMemoryRow>): Promise<void>;
  deleteById(id: string): Promise<boolean>;
  search(
    vector: number[],
    limit: number,
    minScore: number,
    categoryFilter?: MemoryCategory,
    skipDecay?: boolean,
  ): Promise<MemorySearchResult[]>;
  findByCategory(
    category: MemoryCategory,
    limit?: number,
  ): Promise<AgentMemoryRow[]>;
  getAll(maxLimit?: number): Promise<AgentMemoryRow[]>;
  countRows(): Promise<number>;
  incrementActiveCount(id: string): Promise<void>;
  maintain(options: MaintainOptions): Promise<MaintainResult>;
  optimize?(cleanupOlderThanDays?: number): Promise<OptimizeResult | null>;
  ensureIndices?(vectorIndexThreshold?: number): Promise<void>;
}
