> ⚠️ **ARCHIVED** — This project is no longer maintained. Memory solution replaced by openclaw built-in memory-core.

---

[中文](README.zh-CN.md) | **English**

# epro-memory

LLM-powered agent memory plugin with 6-category classification and L0/L1/L2 tiered structure. Built on [LanceDB](https://lancedb.com/) for vector storage and OpenAI-compatible APIs for extraction and embedding.

## Features

- **6-category memory classification**: profile, preferences, entities, events, cases, patterns
- **L0/L1/L2 tiered structure**: one-sentence abstract (L0), structured summary (L1), full narrative (L2)
- **Automatic memory extraction**: LLM-powered extraction from agent conversations
- **Vector deduplication**: embedding similarity search + LLM dedup decisions (CREATE / MERGE / SKIP)
- **Smart recall**: vector search with configurable relevance threshold, injected as context
- **Category-aware merge**: profile always merges; preferences, entities, patterns support merge; events, cases are append-only

## Quick Start

### Install

```bash
pnpm add @tobybridges/epro-memory
```

### Configure

The plugin requires two API keys — one for embeddings and one for LLM extraction:

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small"
  },
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini"
  }
}
```

> **Important:** Never hardcode API keys. Use environment variables or a secrets manager. See [SECURITY.md](SECURITY.md) for best practices.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.apiKey` | string | *required* | API key for embedding service |
| `embedding.model` | string | `text-embedding-3-small` | Embedding model name |
| `embedding.baseUrl` | string | — | Custom API endpoint (for non-OpenAI providers) |
| `llm.apiKey` | string | *required* | API key for LLM extraction |
| `llm.model` | string | `gpt-4o-mini` | LLM model name |
| `llm.baseUrl` | string | — | Custom API endpoint |
| `dbPath` | string | `~/.clawdbot/memory/epro-lancedb` | LanceDB storage path |
| `autoCapture` | boolean | `true` | Automatically extract memories from conversations |
| `autoRecall` | boolean | `true` | Automatically inject relevant memories as context |
| `recallLimit` | number | `5` | Maximum memories to recall per query |
| `recallMinScore` | number | `0.3` | Minimum similarity score for recall |
| `extractMinMessages` | number | `4` | Minimum conversation messages before extraction |
| `extractMaxChars` | number | `8000` | Maximum conversation characters to process |

## Architecture

### Memory Categories

| Category | Type | Merge Behavior | Description |
|----------|------|----------------|-------------|
| `profile` | User | Always merge | User identity and static attributes |
| `preferences` | User | Merge by topic | User tendencies, habits, and preferences |
| `entities` | User | Merge supported | Projects, people, organizations |
| `events` | User | Append only | Decisions, milestones, things that happened |
| `cases` | Agent | Append only | Problem + solution pairs |
| `patterns` | Agent | Merge supported | Reusable processes and methods |

### Extraction Pipeline

```
Conversation → LLM extraction → Candidate memories
    → Vector similarity search → Dedup decision (CREATE/MERGE/SKIP)
    → Persist to LanceDB
```

### Recall Pipeline

```
User prompt → Embed → Vector search → Filter by score
    → Group by category → Inject as <agent-experience> context
```

## Development

### Prerequisites

- Node.js 20+
- pnpm

### Build

```bash
pnpm install
pnpm build
```

### Test

```bash
# Unit tests
pnpm test

# Integration tests (requires LanceDB)
pnpm test:integration

# All tests
pnpm test:all
```

## Technical Choices

| Component | Choice | Why |
|-----------|--------|-----|
| Vector storage | [LanceDB](https://lancedb.com/) | Embedded, serverless, no external DB process needed |
| Config validation | [TypeBox](https://github.com/sinclairzx81/typebox) | JSON Schema-compatible type-safe validation at runtime |
| Embedding & LLM | OpenAI-compatible API | Broad provider support via `baseUrl` override |
| Memory classification | 6-category system | Balances granularity and merge semantics — ported from [OpenViking](https://github.com/toby-bridges/OpenViking) |
| Tiered structure | L0 / L1 / L2 | Inject only what's needed: one-liner for recall, full narrative on demand |
| Dedup strategy | Vector pre-filter + LLM decision | Eliminates duplicates without losing nuance |

## Testing

106 unit tests across 7 test suites. Integration tests run separately against a real LanceDB instance.

| Suite | Tests | Covers |
|-------|-------|--------|
| config | 23 | Schema validation, type coercion, range checks, defaults |
| validators | 19 | UUID format, category allowlist, SQL injection rejection |
| llm-parser | 22 | JSON extraction from LLM responses, edge cases |
| conversation | 17 | Message extraction, truncation, content block formats |
| extractor | 13 | Memory extraction pipeline, candidate parsing |
| deduplicator | 12 | Vector dedup, merge decisions, category-aware logic |
| db.integration | 7 | LanceDB CRUD, vector search, concurrent writes (skipped in CI) |

```bash
pnpm test          # unit tests
pnpm test:all      # unit + integration
```

## Acknowledgments

The 6-category memory classification, L0/L1/L2 tiered structure, and prompt templates (extraction, dedup, merge) are ported from the [OpenViking](https://github.com/toby-bridges/OpenViking) project — an open-source LLM agent framework with persistent memory.

## License

[Apache License 2.0](LICENSE)
