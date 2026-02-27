/**
 * Memory extraction orchestrator.
 * Pipeline: extract candidates -> dedup -> persist to LanceDB.
 * Ported from OpenViking's compressor.py.
 *
 * P2-002: Added checkpoint support for resumable extraction.
 */

import type { MemoryDB } from "./db.js";
import type { MemoryDeduplicator } from "./deduplicator.js";
import type { Embeddings } from "./embeddings.js";
import type { LlmClient } from "./llm.js";
import { buildExtractionPrompt, buildMergePrompt } from "./prompts.js";
import {
  ALWAYS_MERGE_CATEGORIES,
  MERGE_SUPPORTED_CATEGORIES,
  MEMORY_CATEGORIES,
  type CandidateMemory,
  type ExtractionStats,
  type MemoryCategory,
  type PluginLogger,
} from "./types.js";
import type { CheckpointManager, ExtractionCheckpoint } from "./checkpoint.js";

export class MemoryExtractor {
  constructor(
    private db: MemoryDB,
    private embeddings: Embeddings,
    private llm: LlmClient,
    private deduplicator: MemoryDeduplicator,
    private logger: PluginLogger,
  ) {}

  async extractAndPersist(
    conversationText: string,
    sessionKey: string,
    user: string,
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };

    // Step 1: LLM extraction
    const candidates = await this.extractCandidates(conversationText, user);
    if (candidates.length === 0) return stats;

    this.logger.info(
      `epro-memory: extracted ${candidates.length} candidate memories`,
    );

    // Step 2: Process each candidate
    for (const candidate of candidates) {
      try {
        await this.processCandidate(candidate, sessionKey, stats);
      } catch (err) {
        this.logger.warn(
          `epro-memory: failed to process ${candidate.category} memory: ${String(err)}`,
        );
        stats.skipped++;
      }
    }

    this.logger.info(
      `epro-memory: created=${stats.created}, merged=${stats.merged}, skipped=${stats.skipped}`,
    );
    return stats;
  }

  private async extractCandidates(
    conversationText: string,
    user: string,
  ): Promise<CandidateMemory[]> {
    const prompt = buildExtractionPrompt(conversationText, user);

    const data = await this.llm.completeJson<{
      memories: Array<{
        category: string;
        abstract: string;
        overview: string;
        content: string;
      }>;
    }>(prompt);

    if (!data?.memories) return [];

    const validCategories = new Set<string>(MEMORY_CATEGORIES);

    return data.memories
      .filter(
        (m) =>
          m.category &&
          m.abstract &&
          m.content &&
          validCategories.has(m.category),
      )
      .map((m) => ({
        category: m.category as MemoryCategory,
        abstract: m.abstract,
        overview: m.overview || "",
        content: m.content,
      }));
  }

  private async processCandidate(
    candidate: CandidateMemory,
    sessionKey: string,
    stats: ExtractionStats,
  ): Promise<void> {
    // Profile: always merge, skip dedup
    if (ALWAYS_MERGE_CATEGORIES.has(candidate.category)) {
      await this.handleProfileMerge(candidate, sessionKey);
      stats.merged++;
      return;
    }

    // Other categories: embed + dedup
    const vector = await this.embeddings.embed(
      `${candidate.abstract} ${candidate.content}`,
    );

    const result = await this.deduplicator.deduplicate(candidate, vector);

    if (result.decision === "create") {
      await this.db.store({
        category: candidate.category,
        abstract: candidate.abstract,
        overview: candidate.overview,
        content: candidate.content,
        vector,
        source_session: sessionKey,
      });
      stats.created++;
    } else if (result.decision === "merge") {
      if (
        MERGE_SUPPORTED_CATEGORIES.has(candidate.category) &&
        result.matchId
      ) {
        await this.handleMerge(candidate, result.matchId);
        stats.merged++;
      } else {
        // events/cases don't support merge — create as new record to avoid data loss
        await this.db.store({
          category: candidate.category,
          abstract: candidate.abstract,
          overview: candidate.overview,
          content: candidate.content,
          vector,
          source_session: sessionKey,
        });
        stats.created++;
      }
    } else {
      // skip
      stats.skipped++;
    }
  }

  private async handleProfileMerge(
    candidate: CandidateMemory,
    sessionKey: string,
  ): Promise<void> {
    const existing = await this.db.findByCategory("profile");

    if (existing.length === 0) {
      const vector = await this.embeddings.embed(
        `${candidate.abstract} ${candidate.content}`,
      );
      await this.db.store({
        category: "profile",
        abstract: candidate.abstract,
        overview: candidate.overview,
        content: candidate.content,
        vector,
        source_session: sessionKey,
      });
      return;
    }

    const target = existing[0];
    const merged = await this.mergeMemory(target, candidate);
    const mergedVector = await this.embeddings.embed(
      `${merged.abstract} ${merged.content}`,
    );

    await this.db.update(target.id, {
      abstract: merged.abstract,
      overview: merged.overview,
      content: merged.content,
      vector: mergedVector,
    });
  }

  private async handleMerge(
    candidate: CandidateMemory,
    matchId: string,
  ): Promise<void> {
    const target = await this.db.getById(matchId);
    if (!target) return;

    const merged = await this.mergeMemory(target, candidate);
    const mergedVector = await this.embeddings.embed(
      `${merged.abstract} ${merged.content}`,
    );

    await this.db.update(matchId, {
      abstract: merged.abstract,
      overview: merged.overview,
      content: merged.content,
      vector: mergedVector,
    });
  }

  private async mergeMemory(
    existing: { abstract: string; overview: string; content: string },
    candidate: CandidateMemory,
  ): Promise<{ abstract: string; overview: string; content: string }> {
    const prompt = buildMergePrompt(
      existing.abstract,
      existing.overview,
      existing.content,
      candidate.abstract,
      candidate.overview,
      candidate.content,
      candidate.category,
    );
    const data = await this.llm.completeJson<{
      abstract: string;
      overview: string;
      content: string;
    }>(prompt);
    if (data?.abstract && data?.content) {
      return {
        abstract: data.abstract,
        overview: data.overview || candidate.overview,
        content: data.content,
      };
    }
    // Fallback: keep candidate's L0/L1 with candidate's L2
    return {
      abstract: candidate.abstract,
      overview: candidate.overview,
      content: candidate.content,
    };
  }

  /**
   * Extract and persist memories with checkpoint support for resumability.
   * If interrupted, can resume from the last saved checkpoint.
   *
   * P2-002: Checkpoint-based extraction for fault tolerance.
   *
   * @param conversationText - The conversation to extract memories from
   * @param sessionKey - Unique key identifying this extraction session
   * @param user - User identifier
   * @param checkpointMgr - CheckpointManager instance for persistence
   * @returns Extraction statistics
   */
  async extractWithCheckpoint(
    conversationText: string,
    sessionKey: string,
    user: string,
    checkpointMgr: CheckpointManager,
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };

    // Check for existing checkpoint (resume case)
    let checkpoint = await checkpointMgr.load(sessionKey);
    let candidates: CandidateMemory[];
    let startIndex: number;

    if (checkpoint) {
      // Resume from checkpoint
      this.logger.info(
        `epro-memory: resuming from checkpoint: stage=${checkpoint.stage}, ` +
          `progress=${checkpoint.processedIndex + 1}/${checkpoint.candidates.length}`,
      );
      candidates = checkpoint.candidates;
      startIndex = checkpoint.processedIndex + 1; // Start after last processed
    } else {
      // New extraction: extract candidates first
      candidates = await this.extractCandidates(conversationText, user);
      if (candidates.length === 0) return stats;

      this.logger.info(
        `epro-memory: extracted ${candidates.length} candidate memories`,
      );

      // Create initial checkpoint
      checkpoint = checkpointMgr.createInitial(sessionKey, candidates, user);
      await checkpointMgr.save(checkpoint);
      startIndex = 0;
    }

    // Process each candidate from startIndex
    for (let i = startIndex; i < candidates.length; i++) {
      const candidate = candidates[i];

      try {
        await this.processCandidate(candidate, sessionKey, stats);
      } catch (err) {
        this.logger.warn(
          `epro-memory: failed to process ${candidate.category} memory: ${String(err)}`,
        );
        stats.skipped++;
      }

      // Save checkpoint after each candidate
      checkpoint = checkpointMgr.updateProgress(checkpoint, i, "storing");
      await checkpointMgr.save(checkpoint);
    }

    // Extraction complete: clear checkpoint
    await checkpointMgr.clear(sessionKey);

    this.logger.info(
      `epro-memory: created=${stats.created}, merged=${stats.merged}, skipped=${stats.skipped}`,
    );
    return stats;
  }

  /**
   * Resume incomplete extractions found at startup.
   * Used for auto-recovery when checkpoint.autoRecoverOnStart is enabled.
   *
   * @param checkpointMgr - CheckpointManager instance
   * @returns Array of extraction stats for each resumed extraction
   */
  async resumeIncomplete(
    checkpointMgr: CheckpointManager,
  ): Promise<ExtractionStats[]> {
    const incompleteCheckpoints = await checkpointMgr.findIncomplete();
    const results: ExtractionStats[] = [];

    for (const checkpoint of incompleteCheckpoints) {
      this.logger.info(
        `epro-memory: auto-resuming incomplete extraction: ${checkpoint.sessionKey}`,
      );

      try {
        // Resume using the checkpoint data
        // Note: We don't have the original conversation text, but we have the candidates
        const stats = await this.resumeFromCheckpoint(
          checkpoint,
          checkpointMgr,
        );
        results.push(stats);
      } catch (err) {
        this.logger.error(
          `epro-memory: failed to resume extraction ${checkpoint.sessionKey}: ${String(err)}`,
        );
      }
    }

    return results;
  }

  /**
   * Resume extraction from a specific checkpoint.
   * Internal method for resumeIncomplete.
   */
  private async resumeFromCheckpoint(
    checkpoint: ExtractionCheckpoint,
    checkpointMgr: CheckpointManager,
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
    const { sessionKey, candidates, processedIndex } = checkpoint;
    const startIndex = processedIndex + 1;

    this.logger.info(
      `epro-memory: resuming ${sessionKey} from index ${startIndex}/${candidates.length}`,
    );

    // Process remaining candidates
    let currentCheckpoint = checkpoint;
    for (let i = startIndex; i < candidates.length; i++) {
      const candidate = candidates[i];

      try {
        await this.processCandidate(candidate, sessionKey, stats);
      } catch (err) {
        this.logger.warn(
          `epro-memory: failed to process ${candidate.category} memory: ${String(err)}`,
        );
        stats.skipped++;
      }

      // Save checkpoint after each candidate
      currentCheckpoint = checkpointMgr.updateProgress(
        currentCheckpoint,
        i,
        "storing",
      );
      await checkpointMgr.save(currentCheckpoint);
    }

    // Clear checkpoint on completion
    await checkpointMgr.clear(sessionKey);

    this.logger.info(
      `epro-memory: resumed extraction complete: created=${stats.created}, merged=${stats.merged}, skipped=${stats.skipped}`,
    );
    return stats;
  }
}
