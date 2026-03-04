# ePro v2 — OpenClaw Agent Memory Plugin Design

## Context

Mac Mini worker bots need persistent experience memory across sessions. The existing `memory-lancedb` plugin uses rule-based regex triggers for capture (unreliable) and flat vector search for retrieval. ePro v2 replaces it with OpenViking's LLM-powered extraction pipeline, 6-category classification, and L0/L1/L2 tiered memory structure — all in pure TypeScript with LanceDB storage.

**Goal:** New OpenClaw plugin. Coexist with memory-lancedb initially, replace it when stable.

**Constraint:** The separate `agent-memory/` repository is NOT touched — that's memX-specific.

---

## Three-Layer Memory Architecture

```
Agent Memory (ePro v2)    — bot work experience, LanceDB, this plugin
Human Memory (memX)       — user memories, SQLite+sqlite-vec, via memx-bridge plugin
Resource Index (QMD)      — workspace docs/project files, existing QMD MCP server
```

---

## File Structure

```
extensions/epro-memory/
  index.ts              # Plugin entry + hook registration
  config.ts             # Config schema (TypeBox) + defaults
  db.ts                 # LanceDB operations (CRUD, vector search, schema)
  embeddings.ts         # OpenAI-compatible embedding service
  llm.ts                # LLM client (extraction, dedup, merge calls)
  extractor.ts          # Memory extraction pipeline (agent_end)
  deduplicator.ts       # Vector pre-filter + LLM dedup decision
  prompts.ts            # Prompt templates (ported from OpenViking YAML)
  types.ts              # Shared types (MemoryCategory, CandidateMemory, etc.)
  package.json          # @moltbot/epro-memory, deps: @lancedb/lancedb, openai
  clawdbot.plugin.json  # Plugin metadata + config JSON schema
```

Estimated ~900 LOC total.

---

## LanceDB Schema

```typescript
// Table: "agent_memories"
type AgentMemoryRow = {
  id: string;                 // UUID
  category: MemoryCategory;   // "profile"|"preferences"|"entities"|"events"|"cases"|"patterns"
  abstract: string;           // L0: one-sentence index (~100 tokens)
  overview: string;           // L1: structured Markdown summary (~500 tokens)
  content: string;            // L2: full narrative
  vector: number[];           // Embedding of abstract + " " + content
  source_session: string;     // Session key for provenance
  active_count: number;       // Usage counter (incremented on recall)
  created_at: number;         // Date.now()
  updated_at: number;         // Date.now()
};
```

Separate DB path: `~/.clawdbot/memory/epro-lancedb` (default).

---

## Config Schema

```typescript
type EproConfig = {
  embedding: {
    model?: string;             // Default: "text-embedding-3-small"
    apiKey: string;             // Supports ${OPENAI_API_KEY}
    baseUrl?: string;           // For non-OpenAI providers
  };
  llm: {
    model?: string;             // Default: "gpt-4o-mini"
    apiKey: string;             // Supports ${OPENAI_API_KEY}
    baseUrl?: string;           // For non-OpenAI providers
  };
  dbPath?: string;              // Default: ~/.clawdbot/memory/epro-lancedb
  autoCapture?: boolean;        // Default: true
  autoRecall?: boolean;         // Default: true
  recallLimit?: number;         // Default: 5
  recallMinScore?: number;      // Default: 0.3
  extractMinMessages?: number;  // Default: 4
  extractMaxChars?: number;     // Default: 8000
};
```

---

## Prompt Templates (ported from OpenViking)

3 mandatory prompts for MVP:

| Source YAML (OpenViking) | TS Function | Purpose |
|--------------------------|-------------|---------|
| compression/memory_extraction.yaml v5.0.0 | buildExtractionPrompt() | 6-category L0/L1/L2 extraction with few-shot examples |
| compression/dedup_decision.yaml v2.0.0 | buildDedupPrompt() | CREATE/MERGE/SKIP decision |
| compression/memory_merge.yaml v1.0.0 | buildMergePrompt() | Merge existing + new content |

Phase 2 (deferred): retrieval/intent_analysis.yaml v2.0.0 for smart recall.

---

## agent_end Hook — Extraction Pipeline

```
event.messages (conversation)
    |
1. Guard: event.success && messages.length >= extractMinMessages
    |
2. extractConversationText(messages, extractMaxChars)
    |
3. LLM call: buildExtractionPrompt(conversationText, user)
   -> Returns JSON: { memories: [{ category, abstract, overview, content }] }
    |
4. Parse -> CandidateMemory[]
    |
5. For each candidate:
   +-- category === "profile" -> always merge (skip dedup)
   |   +-- Read existing profile from LanceDB
   |   +-- LLM call: buildMergePrompt(existing, new, "profile")
   |   +-- Upsert to LanceDB
   |
   +-- other categories -> dedup pipeline:
       +-- Embed candidate (abstract + " " + content)
       +-- Vector search same category, threshold 0.7, limit 5
       |
       +-- No matches -> CREATE (store to LanceDB)
       |
       +-- Has matches -> LLM call: buildDedupPrompt(candidate, matches)
           +-- CREATE -> store to LanceDB
           +-- MERGE (preferences/entities/patterns only)
           |   +-- LLM call: buildMergePrompt(existing, new, category)
           |   +-- Update existing row in LanceDB
           +-- SKIP -> log and discard
```

Merge behavior (from OpenViking):
- ALWAYS_MERGE: profile (skip dedup entirely)
- MERGE_SUPPORTED: preferences, entities, patterns
- NON_MERGEABLE: events, cases (CREATE or SKIP only)

---

## before_agent_start Hook — Recall Pipeline

```
event.prompt (user input)
    |
1. Guard: prompt.length >= 5
    |
2. Embed prompt
    |
3. Vector search: limit=recallLimit, minScore=recallMinScore
    |
4. Format results as L0 abstracts grouped by category
    |
5. Return { prependContext: "<agent-experience>...</agent-experience>" }
```

Uses `<agent-experience>` tag (distinct from memory-lancedb's `<relevant-memories>` and memx-bridge's `<user-memory-context>`).

---

## Coexistence Strategy

| Aspect | memory-lancedb | ePro v2 | Conflict? |
|--------|---------------|---------|-----------|
| DB path | ~/.clawdbot/memory/lancedb | ~/.clawdbot/memory/epro-lancedb | No |
| before_agent_start tag | `<relevant-memories>` | `<agent-experience>` | No (concatenated) |
| agent_end | Parallel execution | Parallel execution | No |
| Tool names | memory_recall/store/forget | No tools in Phase 1 | No |

Phase 2 (post-replacement): Add tools with same names for drop-in replacement.

---

## 6 Memory Categories (from OpenViking)

### UserMemory
- **profile**: User identity (static attributes). Always merge, never dedup.
- **preferences**: User preferences (tendencies, habits). Merge by topic.
- **entities**: Continuously existing nouns (projects, people, orgs). Merge supported.
- **events**: Things that happened (decisions, milestones). CREATE or SKIP only.

### AgentMemory
- **cases**: Problem + solution pairs. CREATE or SKIP only.
- **patterns**: Reusable processes/methods. Merge supported.

---

## L0/L1/L2 Structure

- **L0 (abstract)**: One-sentence summary (~100 tokens). Used for injection and index.
- **L1 (overview)**: Structured Markdown with category-specific headings (~500 tokens). Used for detailed recall.
- **L2 (content)**: Full narrative. Stored but only loaded on demand.

Default injection uses L0 only. Phase 2 adds L1 for high-relevance matches.

---

## Implementation Steps

### Step 1: Scaffold plugin
- Create extensions/epro-memory/ directory
- Write package.json, clawdbot.plugin.json
- Write types.ts (MemoryCategory enum, CandidateMemory, AgentMemoryRow)
- Write config.ts (TypeBox schema + parse)

### Step 2: Storage layer
- Write embeddings.ts (OpenAI-compatible embedding, reuse memory-lancedb pattern)
- Write db.ts (LanceDB init, store, search, update, delete with L0/L1/L2 schema)

### Step 3: Prompt templates
- Write prompts.ts (port 3 OpenViking YAML templates to TS functions)

### Step 4: Extraction pipeline
- Write llm.ts (OpenAI chat completion wrapper)
- Write deduplicator.ts (vector pre-filter + LLM dedup + merge)
- Write extractor.ts (orchestrate: extract -> dedup -> persist)

### Step 5: Plugin wiring
- Write index.ts (register hooks: before_agent_start + agent_end, register service)

### Step 6: Build & test
- pnpm build in the plugin directory
- Manual test with OpenClaw agent
- Verify coexistence with memory-lancedb

---

## Reference Files

| File | Purpose |
|------|---------|
| moltbot-ref/extensions/memory-lancedb/index.ts | Plugin pattern, hook signatures, LanceDB |
| moltbot-ref/extensions/memory-lancedb/config.ts | Config schema pattern |
| moltbot-ref/extensions/memx-bridge/index.ts | Hook patterns |
| moltbot-ref/src/plugins/types.ts | MoltbotPluginApi interface |
| OpenViking/openviking/prompts/templates/compression/memory_extraction.yaml | Extraction prompt |
| OpenViking/openviking/prompts/templates/compression/dedup_decision.yaml | Dedup prompt |
| OpenViking/openviking/prompts/templates/compression/memory_merge.yaml | Merge prompt |
| OpenViking/openviking/session/memory_extractor.py | Extraction logic |
| OpenViking/openviking/session/memory_deduplicator.py | Dedup logic |
| OpenViking/openviking/session/compressor.py | Orchestration logic |

---

## Verification

1. pnpm build — TypeScript compiles without errors
2. Manual test: Start OpenClaw agent with ePro v2 enabled alongside memory-lancedb
3. Run a conversation -> check agent_end logs for "epro-memory: extracted N memories"
4. Start another conversation -> check before_agent_start logs for "epro-memory: injecting N memories"
5. Verify <agent-experience> tag appears alongside <relevant-memories>
6. Inspect LanceDB at ~/.clawdbot/memory/epro-lancedb for stored memories with L0/L1/L2 fields

---

## Implementation Review

Design goals: **100% implemented, zero gaps.**

| Design Item | Status | Notes |
|-------------|--------|-------|
| 9 source files | ✅ All created | index/config/db/embeddings/llm/extractor/deduplicator/prompts/types |
| LanceDB Schema | ✅ Exact match | AgentMemoryRow — all 10 fields match |
| Config Schema | ✅ Exact match | 10 config options + extra range validation |
| 3 OpenViking prompts | ✅ All ported | extraction / dedup / merge |
| Extraction pipeline (agent_end) | ✅ Complete | guard → extract → parse → dedup/merge → persist |
| Recall pipeline (before_agent_start) | ✅ Complete | embed → search → L0 grouping → `<agent-experience>` injection |
| 6 memory categories | ✅ All implemented | Merge behaviors match design |
| L0/L1/L2 tiered structure | ✅ All implemented | Recall injects L0; L1/L2 stored for Phase 2 expansion |
| Coexistence strategy | ✅ Properly isolated | Separate DB path + distinct XML tags |
| Code size | 1,397 LOC | 55% above ~900 estimate — extra validation, thread safety, security hardening |

### Phase 2 Deferrals (as planned)

- ⏳ `intent_analysis.yaml` — smart recall prompt
- ⏳ Drop-in tool replacement for memory-lancedb
- ⏳ L1 injection for high-relevance matches

### Phase 2 Backlog (from user feedback) — COMPLETED

- ✅ **Memory cleanup / lifecycle management** — Added `deleteById()`, `getAll()`, `maintain()` with two-phase cleanup (TTL expiration with active_count grace + count-based cap with activity/recency scoring). Profile memories protected by default. Config: `cleanupAfterExtraction` (opt-in), `maxMemories`, `memoryTTLDays`.
- ✅ **LanceDB compaction** — Added `optimize()` method calling `table.optimize({ cleanupOlderThan })` as fire-and-forget after extraction. Config: `optimizeAfterExtraction` (default true).
- ✅ **Retrieval scaling** — Added `countRows()`, `ensureIndices()` with bitmap index on `category` (always) and IVF_PQ vector index when rows >= threshold. Config: `autoIndex` (default true), `indexThreshold` (default 1000).

### Phase 3 Backlog (future)

- ⏳ **Bayesian confidence scoring** — Replace `active_count` counter with directional `confidence` probability field. Bayesian update on recall (positive signal), time decay toward prior when idle. Integrate into decay scoring formula as `confidence` weight. Minimal pipeline change: only affects recall read/write path, no extraction/dedup changes. Key open question: feedback signal source — start with "recall = positive + time decay" as minimum viable version; richer signals (user confirmation/contradiction) require a feedback channel that doesn't exist yet.
- ⏳ **Memory primitives / atomic units** — See `agent-research/docs/memory/discussion-memory-primitives.md`. Whether to decompose AgentMemoryRow into finer-grained knowledge units (facts, steps, relations). Pending architectural decision.

### Quality Additions (beyond original scope)

- UUID / category whitelist input validation
- LanceDB write-lock serialization (thread safety)
- Robust LLM JSON parsing (markdown fences + balanced-brace extraction)
- Prompt injection prevention (XML tag sanitization)
- 7 test suites / 106 unit tests
