/**
 * Config schema for ePro memory plugin.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const EmbeddingConfig = Type.Object({
  model: Type.Optional(Type.String()),
  apiKey: Type.String(),
  baseUrl: Type.Optional(Type.String()),
});

const LlmConfig = Type.Object({
  model: Type.Optional(Type.String()),
  apiKey: Type.String(),
  baseUrl: Type.Optional(Type.String()),
});

const EproConfigSchema = Type.Object({
  embedding: EmbeddingConfig,
  llm: LlmConfig,
  dbPath: Type.Optional(Type.String()),
  autoCapture: Type.Optional(Type.Boolean()),
  autoRecall: Type.Optional(Type.Boolean()),
  recallLimit: Type.Optional(Type.Number()),
  recallMinScore: Type.Optional(Type.Number()),
  extractMinMessages: Type.Optional(Type.Number()),
  extractMaxChars: Type.Optional(Type.Number()),
  optimizeAfterExtraction: Type.Optional(Type.Boolean()),
  autoIndex: Type.Optional(Type.Boolean()),
  indexThreshold: Type.Optional(Type.Number()),
});

type EproConfig = Static<typeof EproConfigSchema>;

export const DEFAULTS = {
  embeddingModel: "text-embedding-3-small",
  llmModel: "gpt-4o-mini",
  dbPath: "~/.clawdbot/memory/epro-lancedb",
  autoCapture: true,
  autoRecall: true,
  recallLimit: 5,
  recallMinScore: 0.3,
  extractMinMessages: 4,
  extractMaxChars: 8000,
  optimizeAfterExtraction: true,
  autoIndex: true,
  indexThreshold: 1000,
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

const NUMERIC_FIELDS = [
  "recallLimit",
  "recallMinScore",
  "extractMinMessages",
  "extractMaxChars",
  "indexThreshold",
] as const;

export function parseConfig(raw: unknown): EproConfig {
  // Reject non-numeric types on numeric fields BEFORE Value.Cast coerces them
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const field of NUMERIC_FIELDS) {
      const v = obj[field];
      if (v === undefined) continue;
      if (v === null) {
        throw new Error(`epro-memory: ${field} must be a number, got null`);
      }
      if (typeof v !== "number" || Number.isNaN(v)) {
        throw new Error(
          `epro-memory: ${field} must be a number, got ${Number.isNaN(v) ? "NaN" : typeof v}`,
        );
      }
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
  return config as EproConfig;
}
