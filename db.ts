/**
 * Backwards-compatible re-export shim.
 * All LanceDB logic lives in lancedb-store.ts; this file ensures
 * existing imports (`from "./db.js"`) continue to work unchanged.
 */

export { LanceDBStore as MemoryDB } from "./lancedb-store.js";
export { assertCategory, assertUuid, computeDecayScore } from "./utils.js";
export type {
  MemorySearchResult,
  OptimizeResult,
  MaintainResult,
} from "./types.js";
