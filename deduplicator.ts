/**
 * Memory deduplicator.
 * Two-stage pipeline: vector pre-filter -> LLM decision (CREATE/MERGE/SKIP).
 * Ported from OpenViking's memory_deduplicator.py.
 */

import type { MemoryDB, MemorySearchResult } from "./db.js";
import type { LlmClient } from "./llm.js";
import { buildDedupPrompt } from "./prompts.js";
import type {
  CandidateMemory,
  DedupDecision,
  DedupResult,
  PluginLogger,
} from "./types.js";

const SIMILARITY_THRESHOLD = 0.7;
const MAX_SIMILAR_FOR_PROMPT = 3;
const VALID_DECISIONS = new Set(["create", "merge", "skip"]);

export class MemoryDeduplicator {
  constructor(
    private db: MemoryDB,
    private llm: LlmClient,
    private logger: PluginLogger,
  ) {}

  async deduplicate(
    candidate: CandidateMemory,
    candidateVector: number[],
  ): Promise<DedupResult> {
    // Stage 1: Vector pre-filter — find similar memories in same category
    const similar = await this.db.search(
      candidateVector,
      5,
      SIMILARITY_THRESHOLD,
      candidate.category,
      true, // skipDecay: dedup needs pure vector similarity
    );

    if (similar.length === 0) {
      return {
        decision: "create",
        reason: "No similar memories found",
      };
    }

    // Stage 2: LLM decision
    return this.llmDecision(candidate, similar);
  }

  private async llmDecision(
    candidate: CandidateMemory,
    similar: MemorySearchResult[],
  ): Promise<DedupResult> {
    const topSimilar = similar.slice(0, MAX_SIMILAR_FOR_PROMPT);
    const existingFormatted = topSimilar
      .map(
        (r, i) =>
          `${i + 1}. [${r.entry.category}] ${r.entry.abstract}\n   Overview: ${r.entry.overview}\n   Score: ${r.score.toFixed(3)}`,
      )
      .join("\n");

    const prompt = buildDedupPrompt(
      candidate.abstract,
      candidate.overview,
      candidate.content,
      existingFormatted,
    );

    try {
      const data = await this.llm.completeJson<{
        decision: string;
        reason: string;
        match_index?: number;
      }>(prompt);

      if (!data) {
        this.logger.warn(
          "epro-memory: dedup LLM returned unparseable response, defaulting to CREATE",
        );
        return { decision: "create", reason: "LLM response unparseable" };
      }

      const decision = (data.decision?.toLowerCase() ??
        "create") as DedupDecision;
      if (!VALID_DECISIONS.has(decision)) {
        return {
          decision: "create",
          reason: `Unknown decision: ${data.decision}`,
        };
      }

      // Resolve merge target from LLM's match_index (1-based), fall back to top result
      const idx = data.match_index;
      const matchEntry =
        typeof idx === "number" && idx >= 1 && idx <= topSimilar.length
          ? topSimilar[idx - 1]
          : topSimilar[0];

      return {
        decision,
        reason: data.reason ?? "",
        matchId: decision === "merge" ? matchEntry?.entry.id : undefined,
      };
    } catch (err) {
      this.logger.warn(`epro-memory: dedup LLM failed: ${String(err)}`);
      return { decision: "create", reason: `LLM failed: ${String(err)}` };
    }
  }
}
