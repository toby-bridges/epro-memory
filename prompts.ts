/**
 * Prompt templates ported from OpenViking.
 *
 * Sources:
 * - compression/memory_extraction.yaml v5.0.0
 * - compression/dedup_decision.yaml v2.0.0
 * - compression/memory_merge.yaml v1.0.0
 */

export function buildExtractionPrompt(
  conversationText: string,
  user: string,
): string {
  return `Analyze the following session context and extract memories worth long-term preservation.

User: ${user}

Target Output Language: auto (detect from recent messages)

## Recent Conversation
${conversationText}

# Memory Extraction Criteria

## What is worth remembering?
- Personalized information: Information specific to this user, not general domain knowledge
- Long-term validity: Information that will still be useful in future sessions
- Specific and clear: Has concrete details, not vague generalizations

## What is NOT worth remembering?
- General knowledge: "Personalized service is core to romantic vacations" (domain knowledge, not personalized memory)
- Temporary information: One-time questions or conversations
- Vague information: "User has questions about a feature" (no specific details)

# Memory Classification

## Core Decision Logic

When choosing a category, first ask yourself: What is this information mainly about?

| Question | Answer | Category |
|----------|--------|----------|
| Who is the user? | Identity, attributes | profile |
| What does the user prefer? | Preferences, habits | preferences |
| What is this thing? | Person, project, organization | entities |
| What happened? | Decision, milestone | events |
| How was it solved? | Problem + solution | cases |
| What is the process? | Reusable steps | patterns |

## Precise Definition of Each Category

**profile** - User identity (static attributes)
- Core: Describes "who the user is"
- Test: Can it start with "User is..."

**preferences** - User preferences (tendency choices)
- Core: Describes "user tends to/habits"
- Test: Can it be described as "User prefers/likes..."

**entities** - Entities (continuously existing nouns)
- Core: Describes "current state of something"
- Test: Can it be described as "XXX's state is..."

**events** - Events (things that happened)
- Core: Describes "what happened"
- Test: Can it be described as "XXX did/completed/happened..."

**cases** - Cases (problem + solution)
- Core: Describes "how a specific problem was solved"
- Test: Does it contain "problem -> solution" structure

**patterns** - Patterns (reusable processes)
- Core: Describes "what process to follow in what situation"
- Test: Can it be used for "similar situations"

## Common Confusion Clarification

- "Plan to do X" -> events (action, not entity)
- "Project X status: Y" -> entities (describes entity)
- "User prefers X" -> preferences (not profile)
- "Encountered problem A, used solution B" -> cases (not events)
- "General process for handling certain problems" -> patterns (not cases)

# Three-Level Structure

Each memory contains three levels:

**abstract (L0)**: Index layer, plain text one-liner
- Merge types (preferences/entities/profile/patterns): \`[Merge key]: [Description]\`
  - preferences: \`Python code style: No type hints, concise and direct\`
  - entities: \`OpenViking project: AI Agent long-term memory management system\`
  - profile: \`User basic info: AI development engineer, 3 years experience\`
  - patterns: \`Teaching topic handling: Outline->Plan->Generate PPT\`
- Independent types (events/cases): Specific description
  - events: \`Decided to refactor memory system: Simplify to 5 categories\`
  - cases: \`Band not recognized -> Request member/album/style details\`

**overview (L1)**: Structured summary layer, organized with Markdown headings
- preferences: \`## Preference Domain\` / \`## Specific Preferences\`
- entities: \`## Basic Info\` / \`## Core Attributes\`
- events: \`## Decision Content\` / \`## Reason\` / \`## Result\`
- cases: \`## Problem\` / \`## Solution\`

**content (L2)**: Detailed expansion layer, free Markdown, includes background, timeline, complete narrative

# Few-shot Examples

## profile Example
\`\`\`json
{
  "category": "profile",
  "abstract": "User basic info: AI development engineer, 3 years LLM application experience",
  "overview": "## Background Info\\n- Occupation: AI development engineer\\n- Experience: 3 years LLM application development\\n- Tech stack: Python, LangChain",
  "content": "User is an AI development engineer with 3 years of LLM application development experience, mainly using Python and LangChain tech stack."
}
\`\`\`

## preferences Example
\`\`\`json
{
  "category": "preferences",
  "abstract": "Python code style: No type hints, concise and direct",
  "overview": "## Preference Domain\\n- Language: Python\\n- Topic: Code style\\n\\n## Specific Preferences\\n- No type hints\\n- Function comments limited to 1-2 lines\\n- Prioritize concise and direct",
  "content": "User has shown clear preferences for Python code style: dislikes type hints, requires concise function comments limited to 1-2 lines, prefers direct implementation."
}
\`\`\`

## entities Example
\`\`\`json
{
  "category": "entities",
  "abstract": "OpenViking project: AI Agent long-term memory management system",
  "overview": "## Basic Info\\n- Type: Project\\n- Status: Active development\\n- Tech stack: Python, AGFS\\n\\n## Core Features\\n- Memory extraction\\n- Memory deduplication\\n- Memory retrieval",
  "content": "OpenViking is an AI Agent long-term memory management system using Python and AGFS, with memory extraction, deduplication, and retrieval."
}
\`\`\`

## events Example
\`\`\`json
{
  "category": "events",
  "abstract": "Decided to refactor memory system: From 6 categories to 5 categories",
  "overview": "## Decision Content\\nRefactor memory system classification\\n\\n## Reason\\nOriginal categories had blurry boundaries\\n\\n## Result\\nSimplified to clearer categories",
  "content": "During memory system design discussion, decided to refactor from 6 categories to 5 to make classification boundaries clearer."
}
\`\`\`

## cases Example
\`\`\`json
{
  "category": "cases",
  "abstract": "Band not recognized -> Request member/album/style details",
  "overview": "## Problem\\nBand cannot be recognized by system\\n\\n## Solution\\nRequest user to provide band member names, representative albums, music style",
  "content": "User feedback mentioned an unrecognized band. Solution: request more identification details (members, albums, style)."
}
\`\`\`

## patterns Example
\`\`\`json
{
  "category": "patterns",
  "abstract": "Teaching topic handling: Outline->Plan->Generate PPT->Refine content",
  "overview": "## Trigger Condition\\nUser requests teaching content\\n\\n## Process Flow\\n1. List topic outline\\n2. Create detailed plan\\n3. Generate PPT framework\\n4. Refine each section",
  "content": "When user requests teaching content, use four steps: outline, plan, PPT framework, refine sections."
}
\`\`\`

# Output Format

Return JSON:
{
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "abstract": "Merge types use [Merge key]: [Description], independent types use specific description",
      "overview": "Structured Markdown, use different heading templates by category",
      "content": "Free Markdown, complete narrative"
    }
  ]
}

Notes:
- Output language should match the dominant language in the conversation
- Only extract truly valuable personalized information
- If nothing worth recording, return {"memories": []}
- Preferences should be aggregated by topic`;
}

export function buildDedupPrompt(
  candidateAbstract: string,
  candidateOverview: string,
  candidateContent: string,
  existingMemories: string,
): string {
  return `Determine how to handle this candidate memory.

**Candidate Memory**:
Abstract: ${candidateAbstract}
Overview: ${candidateOverview}
Content: ${candidateContent}

**Existing Similar Memories**:
${existingMemories}

Please decide:
- SKIP: Candidate memory duplicates existing memories, no need to save
- CREATE: This is completely new information, should be created
- MERGE: Candidate memory should be merged with existing memories

IMPORTANT: "events" and "cases" categories are independent records — they do NOT support MERGE.
For these categories, only use SKIP or CREATE.

Return JSON format:
{
  "decision": "skip|create|merge",
  "match_index": 1,
  "reason": "Decision reason"
}

If decision is "merge", set "match_index" to the number of the existing memory to merge with (1-based).`;
}

export function buildMergePrompt(
  existingAbstract: string,
  existingOverview: string,
  existingContent: string,
  newAbstract: string,
  newOverview: string,
  newContent: string,
  category: string,
): string {
  return `Merge the following memory into a single coherent record with all three levels.

**Category**: ${category}

**Existing Memory:**
Abstract: ${existingAbstract}
Overview:
${existingOverview}
Content:
${existingContent}

**New Information:**
Abstract: ${newAbstract}
Overview:
${newOverview}
Content:
${newContent}

Requirements:
- Remove duplicate information
- Keep the most up-to-date details
- Maintain a coherent narrative
- Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON:
{
  "abstract": "Merged one-line abstract",
  "overview": "Merged structured Markdown overview",
  "content": "Merged full content"
}`;
}
