/**
 * Shared utilities for ePro memory backends.
 * Pure functions with zero backend dependency.
 */

import { MEMORY_CATEGORIES, type MemoryCategory } from "./types.js";
import type { DecayConfigType } from "./config.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VALID_CATEGORIES = new Set<string>(MEMORY_CATEGORIES);

export function assertCategory(value: string): void {
  if (!VALID_CATEGORIES.has(value)) {
    throw new Error(`Invalid memory category: ${value}`);
  }
}

export function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

/**
 * Computes decay-adjusted score for memory search results.
 *
 * Formula:
 *   decayScore = vectorScore * timeDecay * activeBoost
 *
 * Where:
 *   - timeDecay = 2^(-ageDays / halfLifeDays)  (exponential decay)
 *   - activeBoost = 1 + activeWeight * log(1 + activeCount)  (logarithmic boost)
 *
 * @param vectorScore - Original similarity score from vector search (0-1)
 * @param createdAt - Memory creation timestamp in milliseconds
 * @param activeCount - Number of times this memory was activated/recalled
 * @param config - Decay configuration
 * @returns Decay-adjusted score
 */
export function computeDecayScore(
  vectorScore: number,
  createdAt: number,
  activeCount: number,
  config: Required<DecayConfigType>,
): number {
  if (!config.enabled) return vectorScore;

  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.pow(2, -ageDays / config.halfLifeDays);
  const activeBoost = 1 + config.activeWeight * Math.log(1 + activeCount);

  return vectorScore * timeDecay * activeBoost;
}
