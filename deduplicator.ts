/**
 * Memory deduplicator.
 * Two-stage pipeline: vector pre-filter -> LLM two-tier decision.
 *
 * Decision model (from OpenViking v3.3.1):
 *   Candidate-level: skip | create | none
 *   Per-existing: merge | delete
 *
 * Ported from OpenViking's memory_deduplicator.py.
 */

import type { LlmClient } from "./llm.js";
import { buildDedupPrompt } from "./prompts.js";
import type {
  CandidateMemory,
  DedupDecision,
  DedupResult,
  ExistingMemoryAction,
  MemorySearchResult,
  MemoryStore,
  PluginLogger,
} from "./types.js";

const SIMILARITY_THRESHOLD = 0.7;
const MAX_SIMILAR_FOR_PROMPT = 5;
const VALID_DECISIONS = new Set<DedupDecision>(["create", "skip", "none"]);
const VALID_ACTIONS = new Set(["merge", "delete"]);

export class MemoryDeduplicator {
  constructor(
    private db: MemoryStore,
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
        actions: [],
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
          `${i + 1}. id=${r.entry.id}\n   category=${r.entry.category}\n   score=${r.score.toFixed(3)}\n   abstract=${r.entry.abstract}`,
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
        list?: Array<{
          id?: string;
          index?: number;
          decide?: string;
          reason?: string;
        }>;
        // Legacy fields for backward compat
        match_index?: number;
      }>(prompt);

      if (!data) {
        this.logger.warn(
          "epro-memory: dedup LLM returned unparseable response, defaulting to CREATE",
        );
        return {
          decision: "create",
          reason: "LLM response unparseable",
          actions: [],
        };
      }

      return this.parseDecisionPayload(data, topSimilar);
    } catch (err) {
      this.logger.warn(`epro-memory: dedup LLM failed: ${String(err)}`);
      return {
        decision: "create",
        reason: `LLM failed: ${String(err)}`,
        actions: [],
      };
    }
  }

  private parseDecisionPayload(
    data: {
      decision: string;
      reason: string;
      list?: Array<{
        id?: string;
        index?: number;
        decide?: string;
        reason?: string;
      }>;
      match_index?: number;
    },
    similar: MemorySearchResult[],
  ): DedupResult {
    const rawDecision = (data.decision?.toLowerCase() ?? "create").trim();
    const decision = this.mapDecision(rawDecision);
    const reason = data.reason ?? "";
    const actions = this.parseActions(rawDecision, data, similar);
    return this.enforceConstraints(decision, reason, actions);
  }

  private mapDecision(raw: string): DedupDecision {
    if (raw === "merge") return "none";
    if (VALID_DECISIONS.has(raw as DedupDecision)) return raw as DedupDecision;
    return "create";
  }

  private parseActions(
    rawDecision: string,
    data: {
      list?: Array<{
        id?: string;
        index?: number;
        decide?: string;
        reason?: string;
      }>;
      match_index?: number;
    },
    similar: MemorySearchResult[],
  ): ExistingMemoryAction[] {
    const rawList = Array.isArray(data.list) ? data.list : [];

    // Legacy compat: "merge" with no list → synthesize from match_index
    if (rawDecision === "merge" && rawList.length === 0 && similar.length > 0) {
      const idx = data.match_index;
      const target =
        typeof idx === "number" && idx >= 1 && idx <= similar.length
          ? similar[idx - 1]
          : similar[0];
      return [
        {
          id: target.entry.id,
          action: "merge",
          reason: "Legacy merge mapped to none+merge",
        },
      ];
    }

    const similarById = new Map(similar.map((s) => [s.entry.id, s]));
    const actions: ExistingMemoryAction[] = [];

    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;

      const actionStr = (item.decide ?? "").toLowerCase().trim();
      if (!VALID_ACTIONS.has(actionStr)) continue;

      const targetId = this.resolveTargetId(item, similar, similarById);
      if (!targetId) continue;
      if (actions.some((a) => a.id === targetId)) continue;

      actions.push({
        id: targetId,
        action: actionStr as "merge" | "delete",
        reason: item.reason ?? "",
      });
    }

    return actions;
  }

  private resolveTargetId(
    item: { id?: string; index?: number },
    similar: MemorySearchResult[],
    similarById: Map<string, MemorySearchResult>,
  ): string | undefined {
    if (typeof item.id === "string" && similarById.has(item.id)) {
      return item.id;
    }
    if (typeof item.index === "number") {
      const idx = item.index;
      if (idx >= 1 && idx <= similar.length) return similar[idx - 1].entry.id;
      if (idx >= 0 && idx < similar.length) return similar[idx].entry.id;
    }
    return undefined;
  }

  private enforceConstraints(
    decision: DedupDecision,
    reason: string,
    actions: ExistingMemoryAction[],
  ): DedupResult {
    if (decision === "skip") {
      return { decision, reason, actions: [] };
    }

    const hasMerge = actions.some((a) => a.action === "merge");

    // create + merge → normalize to none
    if (decision === "create" && hasMerge) {
      const normalized = `${reason} | normalized:create+merge->none`
        .trim()
        .replace(/^\| /, "");
      return { decision: "none", reason: normalized, actions };
    }

    // create can only carry delete actions
    if (decision === "create") {
      return {
        decision,
        reason,
        actions: actions.filter((a) => a.action === "delete"),
      };
    }

    return { decision, reason, actions };
  }
}
