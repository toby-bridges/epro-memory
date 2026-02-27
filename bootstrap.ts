/**
 * Pattern Bootstrap for epro-memory.
 *
 * Promotes frequently-recalled patterns to Skill drafts.
 * When a pattern memory reaches a certain active_count threshold,
 * it analyzes the pattern and generates a SKILL.md draft for review.
 *
 * @see ITERATION-SPEC.md P3-001
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import type { AgentMemoryRow, PluginLogger } from "./types.js";

/** Configuration for bootstrap feature */
export interface BootstrapConfig {
  /** Whether bootstrap is enabled */
  enabled: boolean;
  /** Minimum active_count to consider for promotion */
  patternPromotionThreshold: number;
  /** Path to store skill drafts */
  skillDraftPath: string;
  /** Minimum confidence score to generate draft (0-1) */
  minConfidence: number;
}

/** Default bootstrap configuration */
export const DEFAULT_BOOTSTRAP_CONFIG: BootstrapConfig = {
  enabled: false,
  patternPromotionThreshold: 5,
  skillDraftPath: "~/.clawdbot/memory/skill-drafts",
  minConfidence: 0.7,
};

/** A candidate for promotion to Skill */
export interface SkillCandidate {
  /** Suggested skill name (kebab-case) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Trigger phrases/conditions */
  triggers: string[];
  /** Execution steps */
  steps: string[];
  /** ID of the source pattern memory */
  sourcePatternId: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Timestamp when candidate was identified */
  identifiedAt: number;
  /** Whether the draft has been generated */
  draftGenerated: boolean;
}

/** Analysis result from LLM */
export interface PatternAnalysis {
  /** Whether this pattern is suitable for a Skill */
  suitable: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Suggested skill name */
  suggestedName: string;
  /** Extracted trigger conditions */
  triggers: string[];
  /** Extracted execution steps */
  steps: string[];
  /** Reason for the assessment */
  reason: string;
}

/** LLM client interface for pattern analysis */
export interface LLMClient {
  analyze(prompt: string): Promise<string>;
}

/**
 * BootstrapManager handles pattern-to-skill promotion.
 */
export class BootstrapManager {
  private config: BootstrapConfig;
  private draftPath: string;
  private logger: PluginLogger;
  private candidates: Map<string, SkillCandidate> = new Map();
  private llmClient?: LLMClient;

  constructor(
    config: BootstrapConfig,
    logger: PluginLogger,
    llmClient?: LLMClient,
  ) {
    this.config = config;
    this.draftPath = config.skillDraftPath;
    this.logger = logger;
    this.llmClient = llmClient;
  }

  /**
   * Set the LLM client for pattern analysis.
   */
  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
  }

  /**
   * Ensure draft directory exists.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.draftPath, { recursive: true });
  }

  /**
   * Check if a pattern should be considered for promotion.
   */
  shouldConsider(pattern: AgentMemoryRow): boolean {
    if (!this.config.enabled) return false;
    if (pattern.category !== "patterns") return false;
    if (pattern.active_count < this.config.patternPromotionThreshold)
      return false;
    if (this.candidates.has(pattern.id)) return false; // Already processed
    return true;
  }

  /**
   * Analyze a pattern for skill promotion.
   * Returns a SkillCandidate if suitable, null otherwise.
   */
  async checkPatternPromotion(
    pattern: AgentMemoryRow,
  ): Promise<SkillCandidate | null> {
    if (!this.shouldConsider(pattern)) return null;

    this.logger.info(
      `epro-memory: analyzing pattern ${pattern.id.slice(0, 8)} for skill promotion ` +
        `(active_count=${pattern.active_count})`,
    );

    // Analyze the pattern
    const analysis = await this.analyzePatternForSkill(pattern);

    if (!analysis.suitable || analysis.confidence < this.config.minConfidence) {
      this.logger.debug?.(
        `epro-memory: pattern ${pattern.id.slice(0, 8)} not suitable for skill: ${analysis.reason}`,
      );
      return null;
    }

    const candidate: SkillCandidate = {
      name: analysis.suggestedName,
      description: pattern.abstract,
      triggers: analysis.triggers,
      steps: analysis.steps,
      sourcePatternId: pattern.id,
      confidence: analysis.confidence,
      identifiedAt: Date.now(),
      draftGenerated: false,
    };

    // Cache the candidate
    this.candidates.set(pattern.id, candidate);

    this.logger.info(
      `epro-memory: pattern ${pattern.id.slice(0, 8)} identified as skill candidate: ${candidate.name} ` +
        `(confidence=${(candidate.confidence * 100).toFixed(0)}%)`,
    );

    return candidate;
  }

  /**
   * Analyze a pattern to determine if it's suitable for a Skill.
   */
  async analyzePatternForSkill(
    pattern: AgentMemoryRow,
  ): Promise<PatternAnalysis> {
    // If no LLM client, use heuristic analysis
    if (!this.llmClient) {
      return this.heuristicAnalysis(pattern);
    }

    const prompt = this.buildAnalysisPrompt(pattern);

    try {
      const response = await this.llmClient.analyze(prompt);
      return this.parseAnalysisResponse(response, pattern);
    } catch (err) {
      this.logger.warn(
        `epro-memory: LLM analysis failed, falling back to heuristic: ${String(err)}`,
      );
      return this.heuristicAnalysis(pattern);
    }
  }

  /**
   * Build the prompt for LLM analysis.
   */
  private buildAnalysisPrompt(pattern: AgentMemoryRow): string {
    return `Analyze this pattern memory to determine if it should become a reusable Skill.

Pattern Abstract (L0):
${pattern.abstract}

Pattern Overview (L1):
${pattern.overview}

Pattern Content (L2):
${pattern.content}

Active Count: ${pattern.active_count}

Evaluate:
1. Is this pattern reusable and generalizable?
2. Does it describe a clear procedure or workflow?
3. What would trigger this skill?
4. What are the execution steps?

Respond in JSON format:
{
  "suitable": boolean,
  "confidence": number (0-1),
  "suggestedName": "kebab-case-name",
  "triggers": ["trigger phrase 1", "trigger phrase 2"],
  "steps": ["step 1", "step 2"],
  "reason": "brief explanation"
}`;
  }

  /**
   * Parse the LLM response into PatternAnalysis.
   */
  private parseAnalysisResponse(
    response: string,
    pattern: AgentMemoryRow,
  ): PatternAnalysis {
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        suitable: Boolean(parsed.suitable),
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
        suggestedName: String(parsed.suggestedName || this.generateName(pattern)),
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        reason: String(parsed.reason || "LLM analysis"),
      };
    } catch (err) {
      this.logger.warn(
        `epro-memory: failed to parse LLM response: ${String(err)}`,
      );
      return this.heuristicAnalysis(pattern);
    }
  }

  /**
   * Heuristic analysis when LLM is not available.
   */
  private heuristicAnalysis(pattern: AgentMemoryRow): PatternAnalysis {
    const content = pattern.content.toLowerCase();
    const overview = pattern.overview.toLowerCase();

    // Check for procedural indicators
    const hasSteps =
      /step\s*\d|first|then|finally|1\.|2\.|3\./.test(content) ||
      /step\s*\d|first|then|finally|1\.|2\.|3\./.test(overview);

    // Check for trigger indicators
    const hasTriggers =
      /when|if|trigger|upon|after|before/.test(content) ||
      /when|if|trigger|upon|after|before/.test(overview);

    // Check for command-like patterns
    const hasCommands = /run|execute|perform|create|generate|build/.test(
      content,
    );

    const indicators = [hasSteps, hasTriggers, hasCommands].filter(
      Boolean,
    ).length;
    const baseConfidence = 0.3 + indicators * 0.2;

    // Boost confidence for high active_count
    const activeBoost = Math.min(
      0.2,
      pattern.active_count * 0.02,
    );
    const confidence = Math.min(1, baseConfidence + activeBoost);

    // Extract steps from content (simple heuristic)
    const steps = this.extractSteps(pattern.content);
    const triggers = this.extractTriggers(pattern.abstract, pattern.overview);

    return {
      suitable: confidence >= this.config.minConfidence,
      confidence,
      suggestedName: this.generateName(pattern),
      triggers,
      steps,
      reason: `Heuristic analysis: ${indicators}/3 indicators, active=${pattern.active_count}`,
    };
  }

  /**
   * Generate a skill name from pattern content.
   */
  private generateName(pattern: AgentMemoryRow): string {
    // Extract key words from abstract
    const words = pattern.abstract
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !["the", "and", "for", "with"].includes(w))
      .slice(0, 3);

    if (words.length === 0) {
      return `pattern-${pattern.id.slice(0, 8)}`;
    }

    return words.join("-");
  }

  /**
   * Extract steps from content using heuristics.
   */
  private extractSteps(content: string): string[] {
    const steps: string[] = [];

    // Try numbered list
    const numbered = content.match(/\d+\.\s*([^\n]+)/g);
    if (numbered && numbered.length >= 2) {
      return numbered.map((s) => s.replace(/^\d+\.\s*/, "").trim());
    }

    // Try bullet points
    const bullets = content.match(/[-•]\s*([^\n]+)/g);
    if (bullets && bullets.length >= 2) {
      return bullets.map((s) => s.replace(/^[-•]\s*/, "").trim());
    }

    // Split by sentences and take first few
    const sentences = content
      .split(/[.!?]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10)
      .slice(0, 5);

    return sentences.length > 0 ? sentences : ["Execute the pattern as described"];
  }

  /**
   * Extract trigger phrases from abstract and overview.
   */
  private extractTriggers(abstract: string, overview: string): string[] {
    const triggers: string[] = [];
    const combined = `${abstract} ${overview}`;

    // Look for "when..." phrases
    const whenMatch = combined.match(/when\s+([^,.]+)/gi);
    if (whenMatch) {
      triggers.push(...whenMatch.map((m) => m.trim()));
    }

    // Look for "if..." phrases
    const ifMatch = combined.match(/if\s+([^,.]+)/gi);
    if (ifMatch) {
      triggers.push(...ifMatch.map((m) => m.trim()));
    }

    // If no explicit triggers, use abstract as trigger
    if (triggers.length === 0) {
      triggers.push(abstract);
    }

    return triggers.slice(0, 3);
  }

  /**
   * Generate a SKILL.md draft for a candidate.
   */
  generateSkillDraft(candidate: SkillCandidate): string {
    const escapedDescription = candidate.description.replace(/"/g, '\\"');

    return `---
name: ${candidate.name}
description: "${escapedDescription}"
metadata: {"source": "epro-memory-bootstrap", "patternId": "${candidate.sourcePatternId}", "confidence": ${candidate.confidence.toFixed(2)}}
---

# ${candidate.name}

> 自动生成自 epro-memory patterns
> 置信度: ${(candidate.confidence * 100).toFixed(0)}%
> 需要人工审核

## 触发条件

${candidate.triggers.map((t) => `- ${t}`).join("\n")}

## 执行步骤

${candidate.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

---

_此 Skill 草稿由 epro-memory 自举功能生成，请审核后使用_
_源 Pattern ID: ${candidate.sourcePatternId}_
_生成时间: ${new Date(candidate.identifiedAt).toISOString()}_
`;
  }

  /**
   * Save a skill draft to disk.
   */
  async saveDraft(candidate: SkillCandidate): Promise<string> {
    await this.ensureDir();

    const draft = this.generateSkillDraft(candidate);
    const filename = `${candidate.name}.md`;
    const filepath = join(this.draftPath, filename);

    await writeFile(filepath, draft, "utf-8");

    // Update candidate status
    candidate.draftGenerated = true;
    this.candidates.set(candidate.sourcePatternId, candidate);

    // Save candidates index
    await this.saveCandidatesIndex();

    this.logger.info(`epro-memory: saved skill draft to ${filepath}`);

    return filepath;
  }

  /**
   * Save candidates index to disk for persistence.
   */
  private async saveCandidatesIndex(): Promise<void> {
    await this.ensureDir();
    const indexPath = join(this.draftPath, "candidates-index.json");
    const data = Object.fromEntries(this.candidates.entries());
    await writeFile(indexPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Load candidates index from disk.
   */
  async loadCandidatesIndex(): Promise<void> {
    try {
      const indexPath = join(this.draftPath, "candidates-index.json");
      const content = await readFile(indexPath, "utf-8");
      const data = JSON.parse(content) as Record<string, SkillCandidate>;
      this.candidates = new Map(Object.entries(data));
      this.logger.debug?.(
        `epro-memory: loaded ${this.candidates.size} skill candidates`,
      );
    } catch {
      // No index file yet
    }
  }

  /**
   * Get all candidates that haven't had drafts generated yet.
   */
  getPendingCandidates(): SkillCandidate[] {
    return [...this.candidates.values()].filter((c) => !c.draftGenerated);
  }

  /**
   * Get all candidates.
   */
  getAllCandidates(): SkillCandidate[] {
    return [...this.candidates.values()];
  }

  /**
   * Record a skill candidate (for external use).
   */
  async recordSkillCandidate(candidate: SkillCandidate): Promise<void> {
    this.candidates.set(candidate.sourcePatternId, candidate);
    await this.saveCandidatesIndex();
  }
}
