/**
 * ePro v2 — OpenClaw Agent Memory Plugin
 *
 * LLM-powered memory extraction with 6-category classification,
 * L0/L1/L2 tiered structure, and vector dedup.
 *
 * Hooks:
 * - before_agent_start: recall relevant memories, inject as <agent-experience>
 * - agent_end: extract memories from conversation, dedup, persist to LanceDB
 * - heartbeat: trigger daily QMD projection (if enabled)
 */

import { parseConfig, DEFAULTS, vectorDimsForModel } from "./config.js";
import { LanceDBStore } from "./lancedb-store.js";
import { SQLiteStore } from "./sqlite-store.js";
import { Embeddings } from "./embeddings.js";
import { LlmClient } from "./llm.js";
import { MemoryDeduplicator } from "./deduplicator.js";
import { MemoryExtractor } from "./extractor.js";
import {
  projectToQMD,
  getLastProjectionTime,
  setLastProjectionTime,
  shouldRunProjection,
  type ProjectionConfig,
} from "./projector.js";
import {
  CheckpointManager,
  type CheckpointConfig,
  type ExtractionCheckpoint,
} from "./checkpoint.js";
import { MemoryReporter, type ReporterConfig } from "./reporter.js";
import { BootstrapManager, type BootstrapConfig } from "./bootstrap.js";
import type { ExtractionStats, MemoryStore, PluginLogger } from "./types.js";

type MoltbotPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  on: (
    hookName: string,
    handler: (...args: any[]) => any,
    opts?: { priority?: number },
  ) => void;
  registerService: (service: {
    id: string;
    start: () => void;
    stop?: () => void;
  }) => void;
};

const eproMemoryPlugin = {
  id: "epro-memory",
  name: "ePro Memory",
  description:
    "LLM-powered agent memory with 6-category classification and L0/L1/L2 tiered structure",

  register(api: MoltbotPluginApi) {
    const cfg = parseConfig(api.pluginConfig ?? {});
    const logger = api.logger;

    // Resolve config with defaults
    const embeddingModel = cfg.embedding.model ?? DEFAULTS.embeddingModel;
    const llmModel = cfg.llm.model ?? DEFAULTS.llmModel;
    const dbPath = api.resolvePath(cfg.dbPath ?? DEFAULTS.dbPath);
    const optimizeAfterExtraction =
      cfg.optimizeAfterExtraction ?? DEFAULTS.optimizeAfterExtraction;
    const autoIndex = cfg.autoIndex ?? DEFAULTS.autoIndex;
    const indexThreshold = cfg.indexThreshold ?? DEFAULTS.indexThreshold;
    const cleanupAfterExtraction =
      cfg.cleanupAfterExtraction ?? DEFAULTS.cleanupAfterExtraction;
    const maxMemories = cfg.maxMemories ?? DEFAULTS.maxMemories;
    const memoryTTLDays = cfg.memoryTTLDays ?? DEFAULTS.memoryTTLDays;
    const autoCapture = cfg.autoCapture ?? DEFAULTS.autoCapture;
    const autoRecall = cfg.autoRecall ?? DEFAULTS.autoRecall;
    const recallLimit = cfg.recallLimit ?? DEFAULTS.recallLimit;
    const recallMinScore = cfg.recallMinScore ?? DEFAULTS.recallMinScore;
    const extractMinMessages =
      cfg.extractMinMessages ?? DEFAULTS.extractMinMessages;
    const extractMaxChars = cfg.extractMaxChars ?? DEFAULTS.extractMaxChars;

    // QMD Projection config
    const qmdProjectionConfig: ProjectionConfig = {
      enabled: cfg.qmdProjection?.enabled ?? DEFAULTS.qmdProjection.enabled,
      qmdPath: api.resolvePath(
        cfg.qmdProjection?.qmdPath ?? DEFAULTS.qmdProjection.qmdPath,
      ),
      includeL1:
        cfg.qmdProjection?.includeL1 ?? DEFAULTS.qmdProjection.includeL1,
      categorySeparateFiles:
        cfg.qmdProjection?.categorySeparateFiles ??
        DEFAULTS.qmdProjection.categorySeparateFiles,
      dailyTrigger:
        cfg.qmdProjection?.dailyTrigger ?? DEFAULTS.qmdProjection.dailyTrigger,
      intervalMs:
        cfg.qmdProjection?.intervalMs ?? DEFAULTS.qmdProjection.intervalMs,
    };

    // Checkpoint config (P2-002: Resumable extraction)
    const checkpointEnabled =
      cfg.checkpoint?.enabled ?? DEFAULTS.checkpoint.enabled;
    const checkpointPath = api.resolvePath(
      cfg.checkpoint?.path ?? DEFAULTS.checkpoint.path,
    );
    const checkpointAutoRecover =
      cfg.checkpoint?.autoRecoverOnStart ??
      DEFAULTS.checkpoint.autoRecoverOnStart;

    // Reporter config (P2-001: Memory change reporting)
    const reportingEnabled =
      cfg.reporting?.enabled ?? DEFAULTS.reporting.enabled;
    const reporterConfig: ReporterConfig = {
      enabled: reportingEnabled,
      logPath: api.resolvePath(
        cfg.reporting?.logPath ?? DEFAULTS.reporting.logPath,
      ),
      dailySummary:
        cfg.reporting?.dailySummary ?? DEFAULTS.reporting.dailySummary,
      notifyOnPivotal:
        cfg.reporting?.notifyOnPivotal ?? DEFAULTS.reporting.notifyOnPivotal,
    };

    // Bootstrap config (P3-001: Pattern-to-Skill promotion)
    const bootstrapEnabled =
      cfg.bootstrap?.enabled ?? DEFAULTS.bootstrap.enabled;
    const bootstrapConfig: BootstrapConfig = {
      enabled: bootstrapEnabled,
      patternPromotionThreshold:
        cfg.bootstrap?.patternPromotionThreshold ??
        DEFAULTS.bootstrap.patternPromotionThreshold,
      skillDraftPath: api.resolvePath(
        cfg.bootstrap?.skillDraftPath ?? DEFAULTS.bootstrap.skillDraftPath,
      ),
      minConfidence:
        cfg.bootstrap?.minConfidence ?? DEFAULTS.bootstrap.minConfidence,
    };

    // Initialize services
    const vectorDim =
      cfg.embedding.dimensions ?? vectorDimsForModel(embeddingModel);
    const backend = cfg.backend ?? DEFAULTS.backend;
    let db: MemoryStore;
    if (backend === "sqlite") {
      const sqliteDbPath = api.resolvePath(
        cfg.sqliteDbPath ?? DEFAULTS.sqliteDbPath,
      );
      db = new SQLiteStore(sqliteDbPath, vectorDim, logger, cfg.decay);
    } else {
      db = new LanceDBStore(dbPath, vectorDim, logger, cfg.decay);
    }
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      embeddingModel,
      cfg.embedding.baseUrl,
      cfg.embedding.dimensions,
    );
    const llm = new LlmClient(cfg.llm.apiKey, llmModel, cfg.llm.baseUrl);
    const deduplicator = new MemoryDeduplicator(db, llm, logger);
    const extractor = new MemoryExtractor(
      db,
      embeddings,
      llm,
      deduplicator,
      logger,
    );

    // Initialize checkpoint manager (P2-002)
    const checkpointMgr = checkpointEnabled
      ? new CheckpointManager(checkpointPath, logger)
      : null;

    // Initialize reporter (P2-001)
    const reporter = reportingEnabled
      ? new MemoryReporter(reporterConfig, logger)
      : null;

    // Initialize bootstrap (P3-001)
    const bootstrapMgr = bootstrapEnabled
      ? new BootstrapManager(bootstrapConfig, logger, {
          analyze: (prompt) => llm.complete(prompt),
        })
      : null;

    // Register service lifecycle
    api.registerService({
      id: "epro-memory",
      start: async () => {
        await db.init();

        const dbLabel =
          backend === "sqlite"
            ? api.resolvePath(cfg.sqliteDbPath ?? DEFAULTS.sqliteDbPath)
            : dbPath;
        logger.info(
          `epro-memory: initialized (backend: ${backend}, db: ${dbLabel}, embed: ${embeddingModel}, llm: ${llmModel}` +
            (checkpointEnabled ? `, checkpoint: ${checkpointPath}` : "") +
            ")",
        );

        // Auto-recover incomplete extractions on startup (P2-002)
        if (checkpointMgr && checkpointAutoRecover) {
          try {
            const resumeResults =
              await extractor.resumeIncomplete(checkpointMgr);
            if (resumeResults.length > 0) {
              const total = resumeResults.reduce(
                (acc, r) => ({
                  created: acc.created + r.created,
                  merged: acc.merged + r.merged,
                  skipped: acc.skipped + r.skipped,
                }),
                { created: 0, merged: 0, skipped: 0 },
              );
              logger.info(
                `epro-memory: auto-recovered ${resumeResults.length} incomplete extractions ` +
                  `(created=${total.created}, merged=${total.merged}, skipped=${total.skipped})`,
              );
            }
          } catch (err) {
            logger.warn(`epro-memory: auto-recovery failed: ${String(err)}`);
          }
        }

        // Load pending notifications on startup (P2-001)
        if (reporter) {
          await reporter.loadPendingNotifications();
        }

        // Load candidates index on startup (P3-001)
        if (bootstrapMgr) {
          await bootstrapMgr.loadCandidatesIndex();
        }
      },
    });

    // Hook: before_agent_start — recall relevant memories
    if (autoRecall) {
      api.on("before_agent_start", async (event: { prompt?: string }) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const vector = await embeddings.embed(event.prompt);
          const results = await db.search(vector, recallLimit, recallMinScore);

          if (results.length === 0) return;

          // Increment active_count for recalled memories
          for (const r of results) {
            db.incrementActiveCount(r.entry.id).catch((err) => {
              logger.warn(
                `epro-memory: incrementActiveCount failed: ${String(err)}`,
              );
            });
          }

          // Format as L0 abstracts grouped by category
          const grouped = new Map<string, string[]>();
          for (const r of results) {
            const cat = r.entry.category;
            if (!grouped.has(cat)) grouped.set(cat, []);
            grouped.get(cat)!.push(`- ${sanitizeForContext(r.entry.abstract)}`);
          }

          const lines: string[] = [];
          for (const [cat, items] of grouped) {
            lines.push(`[${cat}]`);
            lines.push(...items);
          }

          const memoryContext = lines.join("\n");
          logger.info(
            `epro-memory: injecting ${results.length} agent memories`,
          );

          return {
            prependContext: `<agent-experience>\nThe following agent experiences may be relevant:\n${memoryContext}\n</agent-experience>`,
          };
        } catch (err) {
          logger.warn(`epro-memory: recall failed: ${String(err)}`);
        }
      });
    }

    // Hook: agent_end — extract and persist memories
    if (autoCapture) {
      api.on(
        "agent_end",
        async (
          event: { success?: boolean; messages?: unknown[] },
          ctx?: { sessionKey?: string; agentId?: string },
        ) => {
          if (!event.success) return;
          if (!event.messages || event.messages.length < extractMinMessages)
            return;

          try {
            const conversationText = extractConversationText(
              event.messages,
              extractMaxChars,
            );
            if (!conversationText || conversationText.length < 50) return;

            const sessionKey = ctx?.sessionKey ?? "unknown";
            const user = ctx?.agentId ?? "agent";

            // Use checkpoint-based extraction if enabled (P2-002)
            let stats: ExtractionStats;
            if (checkpointMgr) {
              stats = await extractor.extractWithCheckpoint(
                conversationText,
                sessionKey,
                user,
                checkpointMgr,
              );
            } else {
              stats = await extractor.extractAndPersist(
                conversationText,
                sessionKey,
                user,
              );
            }

            // Report extraction results (P2-001)
            if (reporter && (stats.created > 0 || stats.merged > 0)) {
              const report = reporter.createReport(sessionKey, stats, [], user);
              reporter.record(report).catch((err) => {
                logger.warn(`epro-memory: reporter failed: ${String(err)}`);
              });
            }

            // Post-extraction maintenance: cleanup stale memories (awaited)
            if (
              cleanupAfterExtraction &&
              (maxMemories > 0 || memoryTTLDays > 0)
            ) {
              try {
                const result = await db.maintain({
                  maxMemories,
                  memoryTTLDays,
                });
                if (result.deleted > 0) {
                  logger.info(
                    `epro-memory: maintain deleted ${result.deleted} memories (${result.reason})`,
                  );
                }
              } catch (err) {
                logger.warn(`epro-memory: maintain failed: ${String(err)}`);
              }
            }

            // Post-extraction maintenance: auto-index (fire-and-forget)
            if (autoIndex && db.ensureIndices) {
              db.ensureIndices(indexThreshold).catch((err) => {
                logger.warn(
                  `epro-memory: ensureIndices failed: ${String(err)}`,
                );
              });
            }

            // Post-extraction maintenance: compact fragments (fire-and-forget)
            if (optimizeAfterExtraction && db.optimize) {
              db.optimize()
                .then((optStats) => {
                  if (optStats) {
                    logger.info(
                      `epro-memory: optimize compacted ${optStats.compaction.fragmentsRemoved} fragments, pruned ${optStats.prune.oldVersionsRemoved} old versions`,
                    );
                  }
                })
                .catch((err) => {
                  logger.warn(`epro-memory: optimize failed: ${String(err)}`);
                });
            }
          } catch (err) {
            logger.warn(`epro-memory: extraction failed: ${String(err)}`);
          }
        },
      );
    }

    // Hook: heartbeat — trigger daily QMD projection
    if (qmdProjectionConfig.enabled && qmdProjectionConfig.dailyTrigger) {
      api.on("heartbeat", async () => {
        try {
          const lastProjection = await getLastProjectionTime(
            qmdProjectionConfig.qmdPath,
          );
          const now = Date.now();

          if (
            !shouldRunProjection(
              lastProjection,
              qmdProjectionConfig.intervalMs,
              now,
            )
          ) {
            return;
          }

          logger.info("epro-memory: starting daily QMD projection");

          const memories = await db.getAll();
          const result = await projectToQMD(
            memories,
            qmdProjectionConfig,
            qmdProjectionConfig.qmdPath,
            logger,
          );

          await setLastProjectionTime(qmdProjectionConfig.qmdPath, now);

          logger.info(
            `epro-memory: QMD projection complete (${result.categoryFilesWritten} category files, ${result.totalMemories} memories)`,
          );
        } catch (err) {
          logger.warn(`epro-memory: QMD projection failed: ${String(err)}`);
        }
      });
    }

    // Hook: heartbeat — daily summary report (P2-001)
    if (reporter && reporterConfig.dailySummary) {
      api.on("heartbeat", async () => {
        try {
          const filepath = await reporter.saveDailyReport();
          if (filepath) {
            logger.info(`epro-memory: daily summary saved to ${filepath}`);
          }
        } catch (err) {
          logger.warn(`epro-memory: daily summary failed: ${String(err)}`);
        }
      });
    }

    // Hook: heartbeat — bootstrap pattern-to-skill promotion (P3-001)
    if (bootstrapMgr) {
      api.on("heartbeat", async () => {
        try {
          const patterns = await db.findByCategory("patterns", 10000);
          for (const pattern of patterns) {
            if (!bootstrapMgr.shouldConsider(pattern)) continue;

            const candidate = await bootstrapMgr.checkPatternPromotion(pattern);
            if (candidate) {
              await bootstrapMgr.saveDraft(candidate);
            }
          }
        } catch (err) {
          logger.warn(`epro-memory: bootstrap failed: ${String(err)}`);
        }
      });
    }
  },
};

/**
 * Extract text from conversation messages.
 * Handles both string content and content block arrays (Anthropic API format).
 */
function extractConversationText(
  messages: unknown[],
  maxChars: number,
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;

    const role = msgObj.role;
    if (role !== "user" && role !== "assistant") continue;

    const prefix = role === "user" ? "Human" : "Assistant";
    const content = msgObj.content;

    if (typeof content === "string") {
      parts.push(`${prefix}: ${content}`);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          parts.push(`${prefix}: ${(block as Record<string, unknown>).text}`);
        }
      }
    }
  }

  const text = parts.join("\n\n");
  if (text.length <= maxChars) return text;
  let truncated = text.slice(0, maxChars);
  // Avoid splitting UTF-16 surrogate pairs
  const lastChar = truncated.charCodeAt(truncated.length - 1);
  if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "\u2026";
}

/**
 * Neutralize XML-like tags in stored text to prevent prompt boundary injection.
 * Only matches `<` followed by an optional `/` and a letter (i.e. actual tag syntax).
 * `</agent-experience>` becomes `< /agent-experience>`, but `5 < 10` is unchanged.
 */
export function sanitizeForContext(text: string): string {
  return text.replace(/<(\/?)([a-zA-Z])/g, "< $1$2");
}

export { extractConversationText, CheckpointManager };
export type { CheckpointConfig, ExtractionCheckpoint };
export default eproMemoryPlugin;
