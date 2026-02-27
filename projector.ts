/**
 * QMD Projection for epro-memory.
 *
 * Generates human-readable markdown files from agent memories:
 * - Per-category files with L0 + L1 content
 * - Daily summaries with statistics
 *
 * @see ITERATION-SPEC.md P1-002
 */

import { writeFile, mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import type { AgentMemoryRow, MemoryCategory, PluginLogger } from "./types.js";

export interface ProjectionConfig {
  enabled: boolean;
  qmdPath: string;
  includeL1: boolean;
  categorySeparateFiles: boolean;
  dailyTrigger: boolean;
  /** Minimum interval between projections in milliseconds. Default: 86400000 (24h) */
  intervalMs: number;
}

export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  enabled: false,
  qmdPath: "~/.clawdbot/memory/qmd",
  includeL1: true,
  categorySeparateFiles: true,
  dailyTrigger: true,
  intervalMs: 24 * 60 * 60 * 1000, // 24 hours
};

const CATEGORY_TITLES: Record<MemoryCategory, string> = {
  profile: "Profile (用户身份)",
  preferences: "Preferences (用户偏好)",
  entities: "Entities (实体)",
  events: "Events (事件)",
  cases: "Cases (问题解决方案)",
  patterns: "Patterns (可复用流程)",
};

/**
 * State file path for tracking last projection time.
 */
function getStatePath(qmdPath: string): string {
  return join(qmdPath, ".projection-state.json");
}

/**
 * Get the timestamp of the last projection.
 */
export async function getLastProjectionTime(qmdPath: string): Promise<number> {
  try {
    const statePath = getStatePath(qmdPath);
    const content = await readFile(statePath, "utf-8");
    const state = JSON.parse(content);
    return state.lastProjection ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Set the timestamp of the last projection.
 */
export async function setLastProjectionTime(
  qmdPath: string,
  timestamp: number,
): Promise<void> {
  const statePath = getStatePath(qmdPath);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({ lastProjection: timestamp }, null, 2),
  );
}

/**
 * Group memories by category.
 */
function groupByCategory(
  memories: AgentMemoryRow[],
): Record<MemoryCategory, AgentMemoryRow[]> {
  const result = {} as Record<MemoryCategory, AgentMemoryRow[]>;

  for (const mem of memories) {
    if (!result[mem.category]) {
      result[mem.category] = [];
    }
    result[mem.category].push(mem);
  }

  return result;
}

/**
 * Format memories for a category as markdown.
 * Outputs L0 (abstract) and optionally L1 (overview), never L2 (content).
 */
export function formatCategoryMarkdown(
  category: MemoryCategory,
  memories: AgentMemoryRow[],
  includeL1: boolean,
): string {
  const title = CATEGORY_TITLES[category] || category;
  const now = new Date().toISOString();

  let md = `# ${title}\n\n`;
  md += `> 更新时间: ${now}\n`;
  md += `> 记忆数量: ${memories.length}\n\n`;
  md += `---\n\n`;

  // Sort by active_count descending, then by created_at descending
  const sorted = [...memories].sort((a, b) => {
    if (b.active_count !== a.active_count) {
      return b.active_count - a.active_count;
    }
    return b.created_at - a.created_at;
  });

  for (const mem of sorted) {
    const shortId = mem.id.slice(0, 8);
    md += `## ${shortId}\n\n`;
    md += `**摘要**: ${mem.abstract}\n\n`;

    if (includeL1 && mem.overview) {
      md += `**详情**:\n${mem.overview}\n\n`;
    }

    md += `- 创建: ${new Date(mem.created_at).toLocaleDateString("zh-CN")}\n`;
    md += `- 活跃: ${mem.active_count} 次\n`;
    md += `- 来源: ${mem.source_session}\n\n`;
    md += `---\n\n`;
  }

  return md;
}

/**
 * Generate a daily summary of all memories.
 * Includes statistics and highlights.
 */
export function generateDailySummary(memories: AgentMemoryRow[]): string {
  const today = new Date().toISOString().split("T")[0];
  const todayStart = new Date(today).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  // Filter memories by time
  const newToday = memories.filter((m) => m.created_at >= todayStart);
  const newYesterday = memories.filter(
    (m) => m.created_at >= yesterdayStart && m.created_at < todayStart,
  );

  // Group by category for stats
  const byCategory = groupByCategory(memories);
  const categoryStats = Object.entries(byCategory)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, items]) => `- ${cat}: ${items.length}`)
    .join("\n");

  // Format today's new memories
  const todayMemories =
    newToday
      .sort((a, b) => b.created_at - a.created_at)
      .map((m) => `- [${m.category}] ${m.abstract}`)
      .join("\n") || "(无)";

  // Get top 5 most active memories
  const topActive = [...memories]
    .sort((a, b) => b.active_count - a.active_count)
    .slice(0, 5)
    .map((m) => `- [${m.category}] ${m.abstract} (${m.active_count}次)`)
    .join("\n");

  return `# 记忆每日摘要 - ${today}

## 统计

- 总记忆数: ${memories.length}
- 今日新增: ${newToday.length}
- 昨日新增: ${newYesterday.length}

## 分类分布

${categoryStats || "(无记忆)"}

## 今日新增记忆

${todayMemories}

## 高活跃记忆 (Top 5)

${topActive || "(无)"}

---

> 自动生成于 ${new Date().toISOString()}
`;
}

export interface ProjectionResult {
  categoryFilesWritten: number;
  summaryWritten: boolean;
  totalMemories: number;
}

/**
 * Project all memories to QMD format.
 *
 * Creates:
 * - Per-category markdown files in `{qmdPath}/by-category/`
 * - Daily summary in `{qmdPath}/summaries/`
 */
export async function projectToQMD(
  memories: AgentMemoryRow[],
  config: ProjectionConfig,
  qmdPath: string,
  logger: PluginLogger,
): Promise<ProjectionResult> {
  if (!config.enabled) {
    return { categoryFilesWritten: 0, summaryWritten: false, totalMemories: 0 };
  }

  const result: ProjectionResult = {
    categoryFilesWritten: 0,
    summaryWritten: false,
    totalMemories: memories.length,
  };

  try {
    // Ensure output directories exist
    const categoryDir = join(qmdPath, "by-category");
    const summaryDir = join(qmdPath, "summaries");
    await mkdir(categoryDir, { recursive: true });
    await mkdir(summaryDir, { recursive: true });

    // Group memories by category
    const byCategory = groupByCategory(memories);

    // Generate per-category files
    if (config.categorySeparateFiles) {
      for (const [category, items] of Object.entries(byCategory)) {
        const content = formatCategoryMarkdown(
          category as MemoryCategory,
          items,
          config.includeL1,
        );
        const filePath = join(categoryDir, `${category}.md`);
        await writeFile(filePath, content, "utf-8");
        result.categoryFilesWritten++;
        logger.info(`epro-memory: projected ${items.length} ${category} memories to ${filePath}`);
      }
    }

    // Generate daily summary
    const date = new Date().toISOString().split("T")[0];
    const summary = generateDailySummary(memories);
    const summaryPath = join(summaryDir, `${date}.md`);
    await writeFile(summaryPath, summary, "utf-8");
    result.summaryWritten = true;
    logger.info(`epro-memory: generated daily summary at ${summaryPath}`);

    return result;
  } catch (err) {
    logger.error(`epro-memory: projection failed: ${String(err)}`);
    throw err;
  }
}

/**
 * Check if projection should run based on configured interval.
 * Returns true if enough time has passed since last projection.
 *
 * @param lastProjection - Timestamp of the last projection
 * @param intervalMs - Minimum interval between projections in milliseconds
 * @param now - Current timestamp (for testing)
 */
export function shouldRunProjection(
  lastProjection: number,
  intervalMs: number,
  now: number = Date.now(),
): boolean {
  return now - lastProjection >= intervalMs;
}
