/**
 * ePro v2 — OpenClaw Agent Memory Plugin
 *
 * LLM-powered memory extraction with 6-category classification,
 * L0/L1/L2 tiered structure, and vector dedup.
 *
 * Hooks:
 * - before_agent_start: recall relevant memories, inject as <agent-experience>
 * - agent_end: extract memories from conversation, dedup, persist to LanceDB
 */

import { parseConfig, DEFAULTS, vectorDimsForModel } from "./config.js";
import { MemoryDB } from "./db.js";
import { Embeddings } from "./embeddings.js";
import { LlmClient } from "./llm.js";
import { MemoryDeduplicator } from "./deduplicator.js";
import { MemoryExtractor } from "./extractor.js";
import type { PluginLogger } from "./types.js";

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
    const autoCapture = cfg.autoCapture ?? DEFAULTS.autoCapture;
    const autoRecall = cfg.autoRecall ?? DEFAULTS.autoRecall;
    const recallLimit = cfg.recallLimit ?? DEFAULTS.recallLimit;
    const recallMinScore = cfg.recallMinScore ?? DEFAULTS.recallMinScore;
    const extractMinMessages =
      cfg.extractMinMessages ?? DEFAULTS.extractMinMessages;
    const extractMaxChars = cfg.extractMaxChars ?? DEFAULTS.extractMaxChars;

    // Initialize services
    const vectorDim = vectorDimsForModel(embeddingModel);
    const db = new MemoryDB(dbPath, vectorDim, logger);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      embeddingModel,
      cfg.embedding.baseUrl,
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

    // Register service lifecycle
    api.registerService({
      id: "epro-memory",
      start: () => {
        logger.info(
          `epro-memory: initialized (db: ${dbPath}, embed: ${embeddingModel}, llm: ${llmModel})`,
        );
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

            await extractor.extractAndPersist(
              conversationText,
              sessionKey,
              user,
            );

            // Post-extraction maintenance: compact fragments (fire-and-forget)
            if (optimizeAfterExtraction) {
              db.optimize()
                .then((stats) => {
                  if (stats) {
                    logger.info(
                      `epro-memory: optimize compacted ${stats.compaction.fragmentsRemoved} fragments, pruned ${stats.prune.oldVersionsRemoved} old versions`,
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

export { extractConversationText };
export default eproMemoryPlugin;
