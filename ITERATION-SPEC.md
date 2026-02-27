# epro-memory 迭代规格说明

> 创建时间: 2026-02-19
> 版本: v2.0
> 状态: 待实现

## 一、迭代目标

基于三原则（AI First、声明式+安全护栏、主动汇报）增强 epro-memory：

| 原则 | 当前 | 目标 |
|------|------|------|
| AI First | 9/10 | 9/10 (保持) |
| 声明式+护栏 | 7/10 | 8/10 |
| 主动汇报 | 6/10 | 8/10 |

## 二、迭代项目

### P1-001: 衰减机制

**优先级**: P1
**工时**: 12-15 小时
**文件**: `db.ts`, `config.ts`

#### 需求

- 实现 30 天半衰期的时间衰减
- 结合 active_count 的活跃度提升
- 可配置的衰减参数

#### 技术设计

```typescript
// config.ts 新增配置
interface DecayConfig {
  enabled: boolean;           // 是否启用衰减
  halfLifeDays: number;       // 半衰期天数，默认 30
  activeWeight: number;       // 活跃度权重，默认 0.1
}

// db.ts 新增函数
function computeDecayScore(
  vectorScore: number,
  createdAt: number,
  activeCount: number,
  config: DecayConfig
): number {
  if (!config.enabled) return vectorScore;

  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.pow(2, -ageDays / config.halfLifeDays);
  const activeBoost = 1 + config.activeWeight * Math.log(1 + activeCount);

  return vectorScore * timeDecay * activeBoost;
}

// 修改 search() 方法
async search(
  vector: number[],
  limit: number,
  minScore: number,
  categoryFilter?: string
): Promise<MemorySearchResult[]> {
  // ... 现有向量搜索逻辑 ...

  // 新增: 应用衰减评分
  return results
    .map(row => ({
      entry: rowToEntry(row),
      score: computeDecayScore(
        1 / (1 + row._distance),
        row.created_at,
        row.active_count,
        this.decayConfig
      )
    }))
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}
```

#### 配置示例

```json
{
  "decay": {
    "enabled": true,
    "halfLifeDays": 30,
    "activeWeight": 0.1
  }
}
```

#### 测试用例

1. 新记忆 (0天) 评分 = vectorScore × 1.0 × activeBoost
2. 30天记忆 评分 = vectorScore × 0.5 × activeBoost
3. 60天记忆 评分 = vectorScore × 0.25 × activeBoost
4. 高活跃记忆 (active_count=10) 比低活跃记忆排名更高

---

### P1-002: 每日 QMD 投影

**优先级**: P1
**工时**: 8-12 小时
**文件**: `projector.ts` (新), `index.ts`, `config.ts`

#### 需求

- 每日生成 QMD 格式的记忆视图
- 输出 L0 + L1（不含 L2）
- 按类别分组

#### 技术设计

```typescript
// projector.ts (新文件)
import { writeFile, mkdir } from 'fs/promises';
import { MemoryDB, AgentMemory } from './db';

export interface ProjectionConfig {
  enabled: boolean;
  qmdPath: string;              // 输出路径
  includeL1: boolean;           // 是否包含 L1
  categorySeparateFiles: boolean; // 是否按类别分文件
}

export async function projectToQMD(
  db: MemoryDB,
  config: ProjectionConfig
): Promise<void> {
  if (!config.enabled) return;

  await mkdir(config.qmdPath, { recursive: true });

  const memories = await db.getAll();
  const byCategory = groupByCategory(memories);

  // 生成分类文件
  if (config.categorySeparateFiles) {
    for (const [category, items] of Object.entries(byCategory)) {
      const content = formatCategoryMarkdown(category, items, config.includeL1);
      await writeFile(
        `${config.qmdPath}/by-category/${category}.md`,
        content
      );
    }
  }

  // 生成每日摘要
  const date = new Date().toISOString().split('T')[0];
  const summary = generateDailySummary(memories);
  await writeFile(`${config.qmdPath}/summaries/${date}.md`, summary);
}

function formatCategoryMarkdown(
  category: string,
  memories: AgentMemory[],
  includeL1: boolean
): string {
  const categoryTitles: Record<string, string> = {
    profile: 'Profile (用户身份)',
    preferences: 'Preferences (用户偏好)',
    entities: 'Entities (实体)',
    events: 'Events (事件)',
    cases: 'Cases (问题解决方案)',
    patterns: 'Patterns (可复用流程)'
  };

  let md = `# ${categoryTitles[category] || category}\n\n`;
  md += `> 更新时间: ${new Date().toISOString()}\n`;
  md += `> 记忆数量: ${memories.length}\n\n`;
  md += `---\n\n`;

  for (const mem of memories) {
    md += `## ${mem.id.slice(0, 8)}\n\n`;
    md += `**摘要**: ${mem.abstract}\n\n`;

    if (includeL1 && mem.overview) {
      md += `**详情**:\n${mem.overview}\n\n`;
    }

    md += `- 创建: ${new Date(mem.created_at).toLocaleDateString()}\n`;
    md += `- 活跃: ${mem.active_count} 次\n`;
    md += `- 来源: ${mem.source_session}\n\n`;
    md += `---\n\n`;
  }

  return md;
}

function generateDailySummary(memories: AgentMemory[]): string {
  const today = new Date().toISOString().split('T')[0];
  const todayMs = new Date(today).getTime();
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;

  const newToday = memories.filter(m => m.created_at >= todayMs);
  const newYesterday = memories.filter(
    m => m.created_at >= yesterdayMs && m.created_at < todayMs
  );

  const byCategory = groupByCategory(memories);
  const categoryStats = Object.entries(byCategory)
    .map(([cat, items]) => `- ${cat}: ${items.length}`)
    .join('\n');

  return `# 记忆每日摘要 - ${today}

## 统计

- 总记忆数: ${memories.length}
- 今日新增: ${newToday.length}
- 昨日新增: ${newYesterday.length}

## 分类分布

${categoryStats}

## 今日新增记忆

${newToday.map(m => `- [${m.category}] ${m.abstract}`).join('\n') || '(无)'}

## 高活跃记忆 (Top 5)

${memories
  .sort((a, b) => b.active_count - a.active_count)
  .slice(0, 5)
  .map(m => `- [${m.category}] ${m.abstract} (${m.active_count}次)`)
  .join('\n')}
`;
}
```

#### 配置示例

```json
{
  "qmdProjection": {
    "enabled": true,
    "qmdPath": "~/.openclaw-*/memory/qmd",
    "includeL1": true,
    "categorySeparateFiles": true
  }
}
```

#### 触发方式

每日定时（通过 OpenClaw heartbeat 或外部 cron）:

```typescript
// index.ts 新增
api.on("heartbeat", async () => {
  const lastProjection = await getLastProjectionTime();
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (now - lastProjection > oneDayMs) {
    await projectToQMD(db, config.qmdProjection);
    await setLastProjectionTime(now);
  }
});
```

---

### P2-001: 主动汇报

**优先级**: P2
**工时**: 4-6 小时
**文件**: `reporter.ts` (新), `index.ts`

#### 需求

- 记忆变更时记录统计
- 提供人类可读的变更报告
- 支持 Discord 通知（可选）

#### 技术设计

```typescript
// reporter.ts (新文件)
export interface MemoryChangeReport {
  timestamp: number;
  sessionKey: string;
  changes: {
    created: number;
    merged: number;
    skipped: number;
  };
  highlights: string[];  // 重要变更的 L0 摘要
}

export class MemoryReporter {
  private reports: MemoryChangeReport[] = [];

  record(report: MemoryChangeReport): void {
    this.reports.push(report);

    // 持久化到文件
    this.appendToLog(report);

    // 如果有重要变更，标记通知
    if (report.changes.created > 0 || report.highlights.length > 0) {
      this.markForNotification(report);
    }
  }

  async generateDailyReport(): Promise<string> {
    const today = new Date().toISOString().split('T')[0];
    const todayReports = this.reports.filter(
      r => new Date(r.timestamp).toISOString().startsWith(today)
    );

    const totalCreated = todayReports.reduce((s, r) => s + r.changes.created, 0);
    const totalMerged = todayReports.reduce((s, r) => s + r.changes.merged, 0);
    const totalSkipped = todayReports.reduce((s, r) => s + r.changes.skipped, 0);

    return `## epro-memory 每日报告 - ${today}

### 统计
- 会话数: ${todayReports.length}
- 新增记忆: ${totalCreated}
- 合并记忆: ${totalMerged}
- 跳过重复: ${totalSkipped}

### 重要变更
${todayReports
  .flatMap(r => r.highlights)
  .map(h => `- ${h}`)
  .join('\n') || '(无)'}
`;
  }
}
```

---

### P2-002: Checkpoint 可重入

**优先级**: P2
**工时**: 4-6 小时
**文件**: `checkpoint.ts` (新), `extractor.ts`

#### 需求

- 提取过程中断时可恢复
- 持久化提取进度
- 自动检测和恢复

#### 技术设计

```typescript
// checkpoint.ts (新文件)
import { readFile, writeFile, unlink } from 'fs/promises';
import { CandidateMemory } from './types';

export interface ExtractionCheckpoint {
  sessionKey: string;
  stage: 'extracting' | 'deduping' | 'storing';
  candidates: CandidateMemory[];
  processedIndex: number;
  timestamp: number;
}

export class CheckpointManager {
  constructor(private basePath: string) {}

  private getPath(sessionKey: string): string {
    return `${this.basePath}/checkpoints/${sessionKey}.json`;
  }

  async save(checkpoint: ExtractionCheckpoint): Promise<void> {
    const path = this.getPath(checkpoint.sessionKey);
    await writeFile(path, JSON.stringify(checkpoint, null, 2));
  }

  async load(sessionKey: string): Promise<ExtractionCheckpoint | null> {
    try {
      const path = this.getPath(sessionKey);
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async clear(sessionKey: string): Promise<void> {
    try {
      await unlink(this.getPath(sessionKey));
    } catch {
      // ignore if not exists
    }
  }

  async findIncomplete(): Promise<ExtractionCheckpoint[]> {
    // 扫描 checkpoints 目录，找到所有未完成的提取
    // 用于启动时恢复
  }
}

// extractor.ts 修改
export async function extractWithCheckpoint(
  conversation: string,
  sessionKey: string,
  checkpointMgr: CheckpointManager,
  db: MemoryDB
): Promise<ExtractionStats> {
  // 检查是否有未完成的 checkpoint
  let checkpoint = await checkpointMgr.load(sessionKey);
  let candidates: CandidateMemory[];
  let startIndex = 0;

  if (checkpoint) {
    console.log(`Resuming from checkpoint: ${checkpoint.stage}, index ${checkpoint.processedIndex}`);
    candidates = checkpoint.candidates;
    startIndex = checkpoint.processedIndex;
  } else {
    // 新提取
    candidates = await extractCandidates(conversation);
    await checkpointMgr.save({
      sessionKey,
      stage: 'extracting',
      candidates,
      processedIndex: 0,
      timestamp: Date.now()
    });
  }

  // 处理每个候选
  for (let i = startIndex; i < candidates.length; i++) {
    await processCandidate(candidates[i], db);

    // 保存进度
    await checkpointMgr.save({
      sessionKey,
      stage: 'storing',
      candidates,
      processedIndex: i + 1,
      timestamp: Date.now()
    });
  }

  // 完成，清除 checkpoint
  await checkpointMgr.clear(sessionKey);

  return stats;
}
```

---

### P3-001: Patterns 自举

**优先级**: P3
**工时**: 8-10 小时
**文件**: `bootstrap.ts` (新), `extractor.ts`

#### 需求

- 当 patterns 类记忆被频繁召回时，提示可创建 Skill
- 生成 SKILL.md 草稿

#### 技术设计

```typescript
// bootstrap.ts (新文件)
import { AgentMemory } from './types';

export interface SkillCandidate {
  name: string;
  description: string;
  triggers: string[];
  steps: string[];
  sourcePatternId: string;
  confidence: number;
}

export async function checkPatternPromotion(
  pattern: AgentMemory,
  threshold: number = 5
): Promise<SkillCandidate | null> {
  if (pattern.category !== 'patterns') return null;
  if (pattern.active_count < threshold) return null;

  // 使用 LLM 分析 pattern 是否适合转为 Skill
  const analysis = await analyzePatternForSkill(pattern);

  if (analysis.confidence < 0.7) return null;

  return {
    name: analysis.suggestedName,
    description: pattern.abstract,
    triggers: analysis.triggers,
    steps: analysis.steps,
    sourcePatternId: pattern.id,
    confidence: analysis.confidence
  };
}

export function generateSkillDraft(candidate: SkillCandidate): string {
  return `---
name: ${candidate.name}
description: "${candidate.description}"
metadata: {"source": "epro-memory-bootstrap", "patternId": "${candidate.sourcePatternId}"}
---

# ${candidate.name}

> 自动生成自 epro-memory patterns
> 置信度: ${(candidate.confidence * 100).toFixed(0)}%
> 需要人工审核

## 触发条件

${candidate.triggers.map(t => `- ${t}`).join('\n')}

## 执行步骤

${candidate.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

---

_此 Skill 草稿由 epro-memory 自举功能生成，请审核后使用_
`;
}
```

#### 触发时机

```typescript
// index.ts 在 before_agent_start 后检查
api.on("before_agent_start", async (event) => {
  // ... 现有召回逻辑 ...

  // 检查高活跃 patterns
  for (const result of results) {
    if (result.entry.category === 'patterns') {
      const candidate = await checkPatternPromotion(result.entry);
      if (candidate) {
        // 记录到待审核列表
        await recordSkillCandidate(candidate);
      }
    }
  }
});
```

---

## 三、配置 Schema 更新

```typescript
// config.ts 完整配置
interface EproMemoryConfig {
  // 现有配置
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  dbPath: string;
  autoCapture: boolean;
  autoRecall: boolean;
  recallLimit: number;
  recallMinScore: number;
  extractMinMessages: number;
  extractMaxChars: number;

  // P1: 衰减配置
  decay: {
    enabled: boolean;
    halfLifeDays: number;      // 默认 30
    activeWeight: number;      // 默认 0.1
  };

  // P1: QMD 投影配置
  qmdProjection: {
    enabled: boolean;
    qmdPath: string;
    includeL1: boolean;
    categorySeparateFiles: boolean;
    dailyTrigger: boolean;     // 是否每日自动触发
  };

  // P2: 主动汇报配置
  reporting: {
    enabled: boolean;
    logPath: string;
    dailySummary: boolean;
    notifyOnPivotal: boolean;  // 重要变更时通知
  };

  // P2: Checkpoint 配置
  checkpoint: {
    enabled: boolean;
    path: string;
    autoRecoverOnStart: boolean;
  };

  // P3: 自举配置
  bootstrap: {
    enabled: boolean;
    patternPromotionThreshold: number;  // 默认 5
    skillDraftPath: string;
  };
}
```

---

## 四、测试计划

### 单元测试

| 模块 | 测试文件 | 用例数 |
|------|----------|--------|
| 衰减计算 | `decay.test.ts` | 8 |
| QMD 投影 | `projector.test.ts` | 10 |
| 主动汇报 | `reporter.test.ts` | 6 |
| Checkpoint | `checkpoint.test.ts` | 8 |
| 自举 | `bootstrap.test.ts` | 6 |

### 集成测试

1. 衰减 + 召回: 验证旧记忆排名下降
2. 投影 + QMD: 验证文件生成和格式
3. Checkpoint + 中断: 模拟中断后恢复
4. 自举 + Skill: 验证草稿生成

---

## 五、实施顺序

```
Week 1:
├─ Day 1-2: P1-001 衰减机制
├─ Day 3-4: P1-002 QMD 投影
└─ Day 5: 集成测试

Week 2:
├─ Day 1: P2-001 主动汇报
├─ Day 2: P2-002 Checkpoint
├─ Day 3-4: P3-001 自举
└─ Day 5: 全量测试 + 文档

并行任务 (由其他 Agent 执行):
├─ EvoClaw 部署到运维大师
└─ 其他配置优化
```

---

## 六、兼容性说明

- 所有新功能默认 `enabled: false`，需显式启用
- 不修改现有 LanceDB schema
- 保持与 memory-lancedb 的共存
- 向后兼容现有配置文件

---

_Last updated: 2026-02-19_
