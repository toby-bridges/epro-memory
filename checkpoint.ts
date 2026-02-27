/**
 * Checkpoint manager for resumable memory extraction.
 * Enables extraction process to resume from where it left off if interrupted.
 *
 * P2-002 from ITERATION-SPEC.md
 */

import { readFile, writeFile, unlink, mkdir, readdir } from "fs/promises";
import { join, dirname } from "path";
import type { CandidateMemory, PluginLogger } from "./types.js";

/** Checkpoint configuration */
export interface CheckpointConfig {
  /** Whether checkpoint feature is enabled. Default: false for backward compatibility */
  enabled: boolean;
  /** Base path for storing checkpoint files */
  path: string;
  /** Whether to auto-recover incomplete extractions on startup. Default: true */
  autoRecoverOnStart: boolean;
}

/** Default checkpoint configuration */
export const CHECKPOINT_DEFAULTS: CheckpointConfig = {
  enabled: false,
  path: "~/.clawdbot/memory/checkpoints",
  autoRecoverOnStart: true,
};

/** Stage of extraction process */
export type ExtractionStage = "extracting" | "deduping" | "storing";

/** Checkpoint data structure for persistence */
export interface ExtractionCheckpoint {
  /** Session key identifying this extraction */
  sessionKey: string;
  /** Current stage of extraction */
  stage: ExtractionStage;
  /** All candidate memories extracted */
  candidates: CandidateMemory[];
  /** Index of last successfully processed candidate (0-based, -1 means none processed) */
  processedIndex: number;
  /** Timestamp when checkpoint was created/updated */
  timestamp: number;
  /** User identifier */
  user: string;
}

/**
 * Manages checkpoint persistence for resumable extraction.
 */
export class CheckpointManager {
  private basePath: string;
  private logger: PluginLogger;

  constructor(basePath: string, logger: PluginLogger) {
    this.basePath = basePath;
    this.logger = logger;
  }

  /**
   * Get the file path for a checkpoint.
   */
  private getPath(sessionKey: string): string {
    // Sanitize sessionKey to be filesystem-safe
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.basePath, `${safeKey}.json`);
  }

  /**
   * Ensure checkpoint directory exists.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  /**
   * Save checkpoint to disk.
   * Called after each candidate is processed.
   */
  async save(checkpoint: ExtractionCheckpoint): Promise<void> {
    await this.ensureDir();
    const path = this.getPath(checkpoint.sessionKey);
    const data = JSON.stringify(checkpoint, null, 2);
    await writeFile(path, data, "utf-8");
    this.logger.debug?.(
      `epro-memory: checkpoint saved for ${checkpoint.sessionKey}, index=${checkpoint.processedIndex}`,
    );
  }

  /**
   * Load checkpoint from disk.
   * Returns null if no checkpoint exists.
   */
  async load(sessionKey: string): Promise<ExtractionCheckpoint | null> {
    try {
      const path = this.getPath(sessionKey);
      const content = await readFile(path, "utf-8");
      const checkpoint = JSON.parse(content) as ExtractionCheckpoint;

      // Validate checkpoint structure
      if (
        !checkpoint.sessionKey ||
        !checkpoint.stage ||
        !Array.isArray(checkpoint.candidates) ||
        typeof checkpoint.processedIndex !== "number"
      ) {
        this.logger.warn(
          `epro-memory: invalid checkpoint structure for ${sessionKey}`,
        );
        return null;
      }

      return checkpoint;
    } catch (err) {
      // File doesn't exist or is unreadable
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          `epro-memory: failed to load checkpoint for ${sessionKey}: ${String(err)}`,
        );
      }
      return null;
    }
  }

  /**
   * Clear checkpoint after successful extraction completion.
   */
  async clear(sessionKey: string): Promise<void> {
    try {
      const path = this.getPath(sessionKey);
      await unlink(path);
      this.logger.debug?.(`epro-memory: checkpoint cleared for ${sessionKey}`);
    } catch (err) {
      // Ignore if file doesn't exist
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          `epro-memory: failed to clear checkpoint for ${sessionKey}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Find all incomplete extractions.
   * Used for startup recovery.
   */
  async findIncomplete(): Promise<ExtractionCheckpoint[]> {
    const incomplete: ExtractionCheckpoint[] = [];

    try {
      await this.ensureDir();
      const files = await readdir(this.basePath);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        try {
          const path = join(this.basePath, file);
          const content = await readFile(path, "utf-8");
          const checkpoint = JSON.parse(content) as ExtractionCheckpoint;

          // Validate and check if incomplete
          if (
            checkpoint.sessionKey &&
            checkpoint.stage &&
            Array.isArray(checkpoint.candidates) &&
            typeof checkpoint.processedIndex === "number" &&
            checkpoint.processedIndex < checkpoint.candidates.length
          ) {
            incomplete.push(checkpoint);
            this.logger.info(
              `epro-memory: found incomplete extraction: ${checkpoint.sessionKey} ` +
                `(${checkpoint.processedIndex + 1}/${checkpoint.candidates.length})`,
            );
          }
        } catch {
          // Skip invalid checkpoint files
          continue;
        }
      }
    } catch (err) {
      // Directory might not exist yet
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          `epro-memory: failed to scan checkpoints: ${String(err)}`,
        );
      }
    }

    return incomplete;
  }

  /**
   * Create initial checkpoint for a new extraction.
   */
  createInitial(
    sessionKey: string,
    candidates: CandidateMemory[],
    user: string,
  ): ExtractionCheckpoint {
    return {
      sessionKey,
      stage: "extracting",
      candidates,
      processedIndex: -1, // No candidates processed yet
      timestamp: Date.now(),
      user,
    };
  }

  /**
   * Update checkpoint after processing a candidate.
   */
  updateProgress(
    checkpoint: ExtractionCheckpoint,
    processedIndex: number,
    stage: ExtractionStage = "storing",
  ): ExtractionCheckpoint {
    return {
      ...checkpoint,
      stage,
      processedIndex,
      timestamp: Date.now(),
    };
  }
}
