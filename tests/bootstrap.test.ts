/**
 * Tests for bootstrap.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BootstrapManager,
  type BootstrapConfig,
  type SkillCandidate,
  type LLMClient,
  DEFAULT_BOOTSTRAP_CONFIG,
} from "../bootstrap.js";
import type { AgentMemoryRow } from "../types.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("BootstrapManager", () => {
  let manager: BootstrapManager;
  let config: BootstrapConfig;

  const createMockPattern = (
    overrides: Partial<AgentMemoryRow> = {},
  ): AgentMemoryRow => ({
    id: "test-pattern-id-1234-5678",
    category: "patterns",
    abstract: "Pattern for deploying applications to production",
    overview:
      "This pattern describes the steps to deploy an application safely to production environment",
    content: `1. Run tests
2. Build the application
3. Push to staging
4. Verify staging works
5. Deploy to production
6. Monitor for errors`,
    vector: [],
    source_session: "session-1",
    active_count: 10,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      ...DEFAULT_BOOTSTRAP_CONFIG,
      enabled: true,
      patternPromotionThreshold: 5,
      skillDraftPath: "/tmp/test-drafts",
      minConfidence: 0.7,
    };
    manager = new BootstrapManager(config, mockLogger);
  });

  describe("shouldConsider", () => {
    it("should return false when disabled", () => {
      const disabledConfig = { ...config, enabled: false };
      const disabledManager = new BootstrapManager(disabledConfig, mockLogger);

      expect(disabledManager.shouldConsider(createMockPattern())).toBe(false);
    });

    it("should return false for non-pattern category", () => {
      const nonPattern = createMockPattern({ category: "entities" });
      expect(manager.shouldConsider(nonPattern)).toBe(false);
    });

    it("should return false for low active_count", () => {
      const lowActive = createMockPattern({ active_count: 3 });
      expect(manager.shouldConsider(lowActive)).toBe(false);
    });

    it("should return true for valid pattern above threshold", () => {
      const validPattern = createMockPattern({ active_count: 10 });
      expect(manager.shouldConsider(validPattern)).toBe(true);
    });

    it("should return true at exact threshold", () => {
      const atThreshold = createMockPattern({ active_count: 5 });
      expect(manager.shouldConsider(atThreshold)).toBe(true);
    });
  });

  describe("heuristicAnalysis", () => {
    it("should detect numbered steps", async () => {
      const pattern = createMockPattern({
        content: "1. First step\n2. Second step\n3. Third step",
      });

      const result = await manager.checkPatternPromotion(pattern);
      expect(result).not.toBeNull();
      expect(result!.steps.length).toBeGreaterThanOrEqual(2);
    });

    it("should detect trigger words", async () => {
      const pattern = createMockPattern({
        overview: "When the user requests a deployment, trigger this workflow",
      });

      const result = await manager.checkPatternPromotion(pattern);
      expect(result).not.toBeNull();
    });

    it("should boost confidence for high active_count", async () => {
      const lowActive = createMockPattern({ active_count: 5 });
      const highActive = createMockPattern({ active_count: 15 });

      const lowResult = await manager.checkPatternPromotion(lowActive);
      const highResult = await manager.checkPatternPromotion(highActive);

      // High active should have better or equal confidence
      if (lowResult && highResult) {
        expect(highResult.confidence).toBeGreaterThanOrEqual(lowResult.confidence);
      }
    });
  });

  describe("generateSkillDraft", () => {
    it("should generate valid SKILL.md format", () => {
      const candidate: SkillCandidate = {
        name: "deploy-to-production",
        description: "Deploy applications to production environment",
        triggers: ["when user requests deployment", "deploy app"],
        steps: ["Run tests", "Build application", "Deploy to production"],
        sourcePatternId: "pattern-123",
        confidence: 0.85,
        identifiedAt: Date.now(),
        draftGenerated: false,
      };

      const draft = manager.generateSkillDraft(candidate);

      // Check YAML frontmatter
      expect(draft).toContain("---");
      expect(draft).toContain("name: deploy-to-production");
      expect(draft).toContain("description:");
      expect(draft).toContain("metadata:");

      // Check content sections
      expect(draft).toContain("# deploy-to-production");
      expect(draft).toContain("## 触发条件");
      expect(draft).toContain("## 执行步骤");
      expect(draft).toContain("置信度: 85%");
      expect(draft).toContain("需要人工审核");

      // Check triggers
      expect(draft).toContain("- when user requests deployment");
      expect(draft).toContain("- deploy app");

      // Check steps
      expect(draft).toContain("1. Run tests");
      expect(draft).toContain("2. Build application");
      expect(draft).toContain("3. Deploy to production");
    });

    it("should escape quotes in description", () => {
      const candidate: SkillCandidate = {
        name: "test-skill",
        description: 'Description with "quotes" inside',
        triggers: ["trigger"],
        steps: ["step"],
        sourcePatternId: "pattern-123",
        confidence: 0.8,
        identifiedAt: Date.now(),
        draftGenerated: false,
      };

      const draft = manager.generateSkillDraft(candidate);
      expect(draft).toContain('\\"quotes\\"');
    });
  });

  describe("generateName", () => {
    it("should generate kebab-case name from abstract", async () => {
      const pattern = createMockPattern({
        abstract: "Deploy Application to Server",
      });

      const result = await manager.checkPatternPromotion(pattern);
      if (result) {
        expect(result.name).toMatch(/^[a-z0-9-]+$/);
        expect(result.name).not.toContain(" ");
      }
    });

    it("should handle special characters", async () => {
      const pattern = createMockPattern({
        abstract: "Build & Deploy! App#123",
      });

      const result = await manager.checkPatternPromotion(pattern);
      if (result) {
        expect(result.name).toMatch(/^[a-z0-9-]+$/);
      }
    });
  });

  describe("extractSteps", () => {
    it("should extract numbered list steps", async () => {
      const pattern = createMockPattern({
        content: "Process:\n1. First action\n2. Second action\n3. Third action",
      });

      const result = await manager.checkPatternPromotion(pattern);
      if (result) {
        expect(result.steps).toContain("First action");
        expect(result.steps).toContain("Second action");
      }
    });

    it("should extract bullet point steps", async () => {
      const pattern = createMockPattern({
        content: "Steps:\n- Do this first\n- Then do this\n- Finally do that",
      });

      const result = await manager.checkPatternPromotion(pattern);
      if (result) {
        expect(result.steps.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("extractTriggers", () => {
    it("should extract when phrases", async () => {
      const pattern = createMockPattern({
        abstract: "Deployment workflow",
        overview: "when user requests a new deployment, execute this pattern",
      });

      const result = await manager.checkPatternPromotion(pattern);
      if (result) {
        const hasWhenTrigger = result.triggers.some((t) =>
          t.toLowerCase().includes("when"),
        );
        expect(hasWhenTrigger).toBe(true);
      }
    });

    it("should use abstract as fallback trigger", async () => {
      const pattern = createMockPattern({
        abstract: "Database backup procedure",
        overview: "This describes how to backup the database",
      });

      const result = await manager.checkPatternPromotion(pattern);
      if (result) {
        expect(result.triggers.length).toBeGreaterThan(0);
      }
    });
  });

  describe("LLM integration", () => {
    it("should use LLM when available", async () => {
      const mockLLM: LLMClient = {
        analyze: vi.fn().mockResolvedValue(
          JSON.stringify({
            suitable: true,
            confidence: 0.9,
            suggestedName: "llm-suggested-name",
            triggers: ["LLM trigger"],
            steps: ["LLM step 1", "LLM step 2"],
            reason: "LLM determined this is suitable",
          }),
        ),
      };

      manager.setLLMClient(mockLLM);
      const pattern = createMockPattern();
      const result = await manager.checkPatternPromotion(pattern);

      expect(mockLLM.analyze).toHaveBeenCalled();
      if (result) {
        expect(result.name).toBe("llm-suggested-name");
        expect(result.triggers).toContain("LLM trigger");
      }
    });

    it("should fallback to heuristic on LLM error", async () => {
      const mockLLM: LLMClient = {
        analyze: vi.fn().mockRejectedValue(new Error("LLM error")),
      };

      manager.setLLMClient(mockLLM);
      const pattern = createMockPattern();
      const result = await manager.checkPatternPromotion(pattern);

      expect(mockLogger.warn).toHaveBeenCalled();
      // Should still return a result from heuristic
      expect(result).not.toBeNull();
    });

    it("should handle malformed LLM response", async () => {
      const mockLLM: LLMClient = {
        analyze: vi.fn().mockResolvedValue("This is not valid JSON"),
      };

      manager.setLLMClient(mockLLM);
      const pattern = createMockPattern();
      const result = await manager.checkPatternPromotion(pattern);

      // Should fallback to heuristic
      expect(result).not.toBeNull();
    });
  });

  describe("candidate management", () => {
    it("should not process same pattern twice", async () => {
      const pattern = createMockPattern();

      const first = await manager.checkPatternPromotion(pattern);
      const second = await manager.checkPatternPromotion(pattern);

      expect(first).not.toBeNull();
      expect(second).toBeNull(); // Already processed
    });

    it("should track pending candidates", async () => {
      const pattern = createMockPattern();
      await manager.checkPatternPromotion(pattern);

      const pending = manager.getPendingCandidates();
      expect(pending.length).toBe(1);
      expect(pending[0].draftGenerated).toBe(false);
    });

    it("should return all candidates", async () => {
      const pattern1 = createMockPattern({ id: "pattern-1" });
      const pattern2 = createMockPattern({ id: "pattern-2" });

      await manager.checkPatternPromotion(pattern1);
      await manager.checkPatternPromotion(pattern2);

      const all = manager.getAllCandidates();
      expect(all.length).toBe(2);
    });
  });
});

describe("DEFAULT_BOOTSTRAP_CONFIG", () => {
  it("should have correct default values", () => {
    expect(DEFAULT_BOOTSTRAP_CONFIG.enabled).toBe(false);
    expect(DEFAULT_BOOTSTRAP_CONFIG.patternPromotionThreshold).toBe(5);
    expect(DEFAULT_BOOTSTRAP_CONFIG.minConfidence).toBe(0.7);
    expect(DEFAULT_BOOTSTRAP_CONFIG.skillDraftPath).toContain("skill-drafts");
  });
});
