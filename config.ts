/**
 * Config schema for ePro memory plugin.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const EmbeddingConfig = Type.Object({
  model: Type.Optional(Type.String()),
  apiKey: Type.String(),
  baseUrl: Type.Optional(Type.String()),
  dimensions: Type.Optional(Type.Number()),
});

const LlmConfig = Type.Object({
  model: Type.Optional(Type.String()),
  apiKey: Type.String(),
  baseUrl: Type.Optional(Type.String()),
});

const DecayConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  halfLifeDays: Type.Optional(Type.Number()),
  activeWeight: Type.Optional(Type.Number()),
});

const QmdProjectionConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  qmdPath: Type.Optional(Type.String()),
  includeL1: Type.Optional(Type.Boolean()),
  categorySeparateFiles: Type.Optional(Type.Boolean()),
  dailyTrigger: Type.Optional(Type.Boolean()),
  intervalMs: Type.Optional(Type.Number()),
});

const CheckpointConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  path: Type.Optional(Type.String()),
  autoRecoverOnStart: Type.Optional(Type.Boolean()),
});

const ReporterConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  logPath: Type.Optional(Type.String()),
  dailySummary: Type.Optional(Type.Boolean()),
  notifyOnPivotal: Type.Optional(Type.Boolean()),
});

const BootstrapConfig = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  patternPromotionThreshold: Type.Optional(Type.Number()),
  skillDraftPath: Type.Optional(Type.String()),
  minConfidence: Type.Optional(Type.Number()),
});

const EproConfigSchema = Type.Object({
  embedding: EmbeddingConfig,
  llm: LlmConfig,
  backend: Type.Optional(
    Type.Union([Type.Literal("lancedb"), Type.Literal("sqlite")]),
  ),
  dbPath: Type.Optional(Type.String()),
  sqliteDbPath: Type.Optional(Type.String()),
  autoCapture: Type.Optional(Type.Boolean()),
  autoRecall: Type.Optional(Type.Boolean()),
  recallLimit: Type.Optional(Type.Number()),
  recallMinScore: Type.Optional(Type.Number()),
  extractMinMessages: Type.Optional(Type.Number()),
  extractMaxChars: Type.Optional(Type.Number()),
  optimizeAfterExtraction: Type.Optional(Type.Boolean()),
  autoIndex: Type.Optional(Type.Boolean()),
  indexThreshold: Type.Optional(Type.Number()),
  cleanupAfterExtraction: Type.Optional(Type.Boolean()),
  maxMemories: Type.Optional(Type.Number()),
  memoryTTLDays: Type.Optional(Type.Number()),
  decay: Type.Optional(DecayConfig),
  qmdProjection: Type.Optional(QmdProjectionConfig),
  checkpoint: Type.Optional(CheckpointConfig),
  reporting: Type.Optional(ReporterConfig),
  bootstrap: Type.Optional(BootstrapConfig),
});

type EproConfig = Static<typeof EproConfigSchema>;
export type DecayConfigType = Static<typeof DecayConfig>;
export type QmdProjectionConfigType = Static<typeof QmdProjectionConfig>;
export type CheckpointConfigType = Static<typeof CheckpointConfig>;
export type ReporterConfigType = Static<typeof ReporterConfig>;
export type BootstrapConfigType = Static<typeof BootstrapConfig>;

export const DEFAULTS = {
  embeddingModel: "text-embedding-3-small",
  llmModel: "gpt-4o-mini",
  backend: "lancedb" as const,
  dbPath: "~/.clawdbot/memory/epro-lancedb",
  sqliteDbPath: "~/.clawdbot/memory/epro.db",
  autoCapture: true,
  autoRecall: true,
  recallLimit: 5,
  recallMinScore: 0.3,
  extractMinMessages: 4,
  extractMaxChars: 8000,
  optimizeAfterExtraction: true,
  autoIndex: true,
  indexThreshold: 1000,
  cleanupAfterExtraction: false,
  maxMemories: 0,
  memoryTTLDays: 0,
  decay: {
    enabled: false,
    halfLifeDays: 30,
    activeWeight: 0.1,
  },
  qmdProjection: {
    enabled: false,
    qmdPath: "~/.clawdbot/memory/qmd",
    includeL1: true,
    categorySeparateFiles: true,
    dailyTrigger: true,
    intervalMs: 24 * 60 * 60 * 1000, // 24 hours
  },
  checkpoint: {
    enabled: false,
    path: "~/.clawdbot/memory/checkpoints",
    autoRecoverOnStart: true,
  },
  reporting: {
    enabled: false,
    logPath: "~/.clawdbot/memory/reports",
    dailySummary: true,
    notifyOnPivotal: true,
  },
  bootstrap: {
    enabled: false,
    patternPromotionThreshold: 5,
    skillDraftPath: "~/.clawdbot/memory/skill-drafts",
    minConfidence: 0.7,
  },
} as const;

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function vectorDimsForModel(model: string): number {
  return EMBEDDING_DIMENSIONS[model] ?? 1536;
}

function assertRange(
  name: string,
  value: unknown,
  min: number,
  max: number,
): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `epro-memory: ${name} must be a number between ${min} and ${max}, got: ${value}`,
    );
  }
}

const BOOLEAN_FIELDS = [
  "autoCapture",
  "autoRecall",
  "optimizeAfterExtraction",
  "autoIndex",
  "cleanupAfterExtraction",
] as const;

const NESTED_BOOLEAN_FIELDS: Array<{
  parent: string;
  fields: readonly string[];
}> = [
  { parent: "decay", fields: ["enabled"] },
  {
    parent: "qmdProjection",
    fields: ["enabled", "includeL1", "categorySeparateFiles", "dailyTrigger"],
  },
  { parent: "checkpoint", fields: ["enabled", "autoRecoverOnStart"] },
  {
    parent: "reporting",
    fields: ["enabled", "dailySummary", "notifyOnPivotal"],
  },
  { parent: "bootstrap", fields: ["enabled"] },
];

const NUMERIC_FIELDS = [
  "recallLimit",
  "recallMinScore",
  "extractMinMessages",
  "extractMaxChars",
  "indexThreshold",
  "maxMemories",
  "memoryTTLDays",
] as const;

const DECAY_NUMERIC_FIELDS = ["halfLifeDays", "activeWeight"] as const;

/** Nested object numeric fields that must be validated before Value.Cast coercion. */
const NESTED_NUMERIC_FIELDS: Array<{
  parent: string;
  fields: readonly string[];
}> = [
  { parent: "decay", fields: DECAY_NUMERIC_FIELDS },
  { parent: "qmdProjection", fields: ["intervalMs"] },
  {
    parent: "bootstrap",
    fields: ["patternPromotionThreshold", "minConfidence"],
  },
];

/**
 * Validate that a value is a proper boolean (not a string or number).
 * Throws with a descriptive message if invalid.
 */
function assertBooleanField(path: string, v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== "boolean") {
    throw new Error(`epro-memory: ${path} must be a boolean, got ${typeof v}`);
  }
}

/**
 * Validate that a value is a proper number (not null, not NaN, not a string).
 * Throws with a descriptive message if invalid.
 */
function assertNumericField(path: string, v: unknown): void {
  if (v === undefined) return;
  if (v === null) {
    throw new Error(`epro-memory: ${path} must be a number, got null`);
  }
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(
      `epro-memory: ${path} must be a number, got ${Number.isNaN(v as number) ? "NaN" : typeof v}`,
    );
  }
}

export function parseConfig(raw: unknown): EproConfig {
  // Reject non-numeric types on numeric fields BEFORE Value.Cast coerces them
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;

    // Top-level boolean fields
    for (const field of BOOLEAN_FIELDS) {
      assertBooleanField(field, obj[field]);
    }

    // Nested boolean fields
    for (const { parent, fields } of NESTED_BOOLEAN_FIELDS) {
      const nested = obj[parent] as Record<string, unknown> | undefined;
      if (nested && typeof nested === "object") {
        for (const field of fields) {
          assertBooleanField(`${parent}.${field}`, nested[field]);
        }
      }
    }

    // Top-level numeric fields
    for (const field of NUMERIC_FIELDS) {
      assertNumericField(field, obj[field]);
    }

    // Nested object numeric fields
    for (const { parent, fields } of NESTED_NUMERIC_FIELDS) {
      const nested = obj[parent] as Record<string, unknown> | undefined;
      if (nested && typeof nested === "object") {
        for (const field of fields) {
          assertNumericField(`${parent}.${field}`, nested[field]);
        }
      }
    }
  }

  // Validate backend before cast
  if (raw && typeof raw === "object") {
    const b = (raw as Record<string, unknown>).backend;
    if (b !== undefined && b !== "lancedb" && b !== "sqlite") {
      throw new Error(
        `epro-memory: backend must be "lancedb" or "sqlite", got: ${JSON.stringify(b)}`,
      );
    }
  }

  const config = Value.Cast(EproConfigSchema, raw);
  if (!config.embedding?.apiKey) {
    throw new Error("epro-memory: embedding.apiKey is required");
  }
  if (!config.llm?.apiKey) {
    throw new Error("epro-memory: llm.apiKey is required");
  }
  assertRange("recallLimit", config.recallLimit, 1, 100);
  assertRange("recallMinScore", config.recallMinScore, 0, 1);
  assertRange("extractMinMessages", config.extractMinMessages, 1, 100);
  assertRange("extractMaxChars", config.extractMaxChars, 100, 100_000);
  assertRange("indexThreshold", config.indexThreshold, 100, 100_000);
  assertRange("maxMemories", config.maxMemories, 0, 100_000);
  assertRange("memoryTTLDays", config.memoryTTLDays, 0, 3650);

  // Validate embedding dimensions
  assertRange("embedding.dimensions", config.embedding?.dimensions, 64, 8192);

  // Validate decay config ranges
  if (config.decay) {
    assertRange("decay.halfLifeDays", config.decay.halfLifeDays, 1, 365);
    assertRange("decay.activeWeight", config.decay.activeWeight, 0, 1);
  }

  // Validate qmdProjection config ranges
  if (config.qmdProjection) {
    assertRange(
      "qmdProjection.intervalMs",
      config.qmdProjection.intervalMs,
      60_000,
      86_400_000 * 30,
    );
  }

  // Validate bootstrap config ranges
  if (config.bootstrap) {
    assertRange(
      "bootstrap.patternPromotionThreshold",
      config.bootstrap.patternPromotionThreshold,
      1,
      1000,
    );
    assertRange(
      "bootstrap.minConfidence",
      config.bootstrap.minConfidence,
      0,
      1,
    );
  }

  return config as EproConfig;
}
