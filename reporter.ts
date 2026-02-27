/**
 * Memory Reporter for epro-memory.
 *
 * Records memory changes and generates human-readable reports.
 * Supports daily summaries and notification marking for important changes.
 *
 * @see ITERATION-SPEC.md P2-001
 */

import { writeFile, readFile, mkdir, appendFile, access } from "fs/promises";
import { join, dirname } from "path";
import type { ExtractionStats, PluginLogger } from "./types.js";

/** Configuration for the reporter */
export interface ReporterConfig {
  /** Whether reporting is enabled */
  enabled: boolean;
  /** Path for storing report logs */
  logPath: string;
  /** Whether to generate daily summaries */
  dailySummary: boolean;
  /** Whether to mark pivotal changes for notification */
  notifyOnPivotal: boolean;
}

/** Default reporter configuration */
export const DEFAULT_REPORTER_CONFIG: ReporterConfig = {
  enabled: false,
  logPath: "~/.clawdbot/memory/reports",
  dailySummary: true,
  notifyOnPivotal: true,
};

/** A single memory change report from one extraction session */
export interface MemoryChangeReport {
  /** Timestamp of the report */
  timestamp: number;
  /** Session key identifying the extraction */
  sessionKey: string;
  /** Change statistics */
  changes: ExtractionStats;
  /** Important changes (L0 abstracts of created/merged memories) */
  highlights: string[];
  /** User identifier */
  user: string;
}

/** Notification record for pending notifications */
export interface PendingNotification {
  timestamp: number;
  sessionKey: string;
  message: string;
  sent: boolean;
}

/**
 * MemoryReporter tracks and reports memory changes.
 */
export class MemoryReporter {
  private logPath: string;
  private logger: PluginLogger;
  private config: ReporterConfig;
  private pendingNotifications: PendingNotification[] = [];

  constructor(config: ReporterConfig, logger: PluginLogger) {
    this.config = config;
    this.logPath = config.logPath;
    this.logger = logger;
  }

  /**
   * Ensure log directory exists.
   */
  private async ensureDir(): Promise<void> {
    await mkdir(this.logPath, { recursive: true });
  }

  /**
   * Get the log file path for a specific date.
   */
  private getLogPath(date: string): string {
    return join(this.logPath, `${date}.jsonl`);
  }

  /**
   * Get the notification queue file path.
   */
  private getNotificationPath(): string {
    return join(this.logPath, "pending-notifications.json");
  }

  /**
   * Record a memory change report.
   * Appends to daily log file and optionally marks for notification.
   */
  async record(report: MemoryChangeReport): Promise<void> {
    if (!this.config.enabled) return;

    await this.ensureDir();

    // Append to daily log (JSONL format)
    const date = new Date(report.timestamp).toISOString().split("T")[0];
    const logPath = this.getLogPath(date);
    const line = JSON.stringify(report) + "\n";
    await appendFile(logPath, line, "utf-8");

    this.logger.debug?.(
      `epro-memory: recorded report for ${report.sessionKey} ` +
        `(+${report.changes.created}, ~${report.changes.merged}, -${report.changes.skipped})`,
    );

    // Mark for notification if there are important changes
    if (this.config.notifyOnPivotal && this.isPivotal(report)) {
      await this.markForNotification(report);
    }
  }

  /**
   * Check if a report contains pivotal (important) changes.
   */
  private isPivotal(report: MemoryChangeReport): boolean {
    // Consider pivotal if:
    // - New memories were created
    // - There are highlights
    return report.changes.created > 0 || report.highlights.length > 0;
  }

  /**
   * Mark a report for notification.
   */
  private async markForNotification(report: MemoryChangeReport): Promise<void> {
    const message = this.formatNotificationMessage(report);
    const notification: PendingNotification = {
      timestamp: report.timestamp,
      sessionKey: report.sessionKey,
      message,
      sent: false,
    };

    this.pendingNotifications.push(notification);
    await this.savePendingNotifications();

    this.logger.info(
      `epro-memory: marked pivotal change for notification: ${report.sessionKey}`,
    );
  }

  /**
   * Format a notification message for a report.
   */
  private formatNotificationMessage(report: MemoryChangeReport): string {
    const parts = [`📝 Memory Update (${report.sessionKey})`];

    if (report.changes.created > 0) {
      parts.push(`+${report.changes.created} new`);
    }
    if (report.changes.merged > 0) {
      parts.push(`~${report.changes.merged} merged`);
    }

    if (report.highlights.length > 0) {
      parts.push("\nHighlights:");
      report.highlights.slice(0, 3).forEach((h) => {
        parts.push(`• ${h}`);
      });
      if (report.highlights.length > 3) {
        parts.push(`... and ${report.highlights.length - 3} more`);
      }
    }

    return parts.join("\n");
  }

  /**
   * Save pending notifications to disk.
   */
  private async savePendingNotifications(): Promise<void> {
    const path = this.getNotificationPath();
    await writeFile(
      path,
      JSON.stringify(this.pendingNotifications, null, 2),
      "utf-8",
    );
  }

  /**
   * Load pending notifications from disk.
   */
  async loadPendingNotifications(): Promise<PendingNotification[]> {
    try {
      const path = this.getNotificationPath();
      const content = await readFile(path, "utf-8");
      this.pendingNotifications = JSON.parse(content);
      return this.pendingNotifications.filter((n) => !n.sent);
    } catch {
      return [];
    }
  }

  /**
   * Mark notifications as sent.
   */
  async markNotificationsSent(sessionKeys: string[]): Promise<void> {
    const keySet = new Set(sessionKeys);
    this.pendingNotifications = this.pendingNotifications.map((n) =>
      keySet.has(n.sessionKey) ? { ...n, sent: true } : n,
    );
    await this.savePendingNotifications();
  }

  /**
   * Load reports for a specific date from log file.
   */
  async loadReportsForDate(date: string): Promise<MemoryChangeReport[]> {
    try {
      const logPath = this.getLogPath(date);
      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as MemoryChangeReport);
    } catch {
      return [];
    }
  }

  /**
   * Generate a daily summary report.
   */
  async generateDailyReport(date?: string): Promise<string> {
    const targetDate = date || new Date().toISOString().split("T")[0];
    const reports = await this.loadReportsForDate(targetDate);

    if (reports.length === 0) {
      return `## epro-memory 每日报告 - ${targetDate}\n\n今日无记忆变更。\n`;
    }

    // Aggregate statistics
    const totalCreated = reports.reduce((s, r) => s + r.changes.created, 0);
    const totalMerged = reports.reduce((s, r) => s + r.changes.merged, 0);
    const totalSkipped = reports.reduce((s, r) => s + r.changes.skipped, 0);

    // Collect all highlights
    const allHighlights = reports.flatMap((r) => r.highlights);

    // Get unique users
    const users = [...new Set(reports.map((r) => r.user))];

    return `## epro-memory 每日报告 - ${targetDate}

### 统计

- 会话数: ${reports.length}
- 新增记忆: ${totalCreated}
- 合并记忆: ${totalMerged}
- 跳过重复: ${totalSkipped}
- 用户: ${users.join(", ") || "(未知)"}

### 重要变更

${allHighlights.length > 0 ? allHighlights.map((h) => `- ${h}`).join("\n") : "(无)"}

### 会话明细

${reports
  .map(
    (r) =>
      `- **${new Date(r.timestamp).toLocaleTimeString("zh-CN")}** ${r.sessionKey}: ` +
      `+${r.changes.created} ~${r.changes.merged} -${r.changes.skipped}`,
  )
  .join("\n")}

---

> 自动生成于 ${new Date().toISOString()}
`;
  }

  /**
   * Generate and save yesterday's daily summary to a markdown file.
   * Returns the file path if written, null if no data or disabled.
   */
  async saveDailyReport(date?: string): Promise<string | null> {
    if (!this.config.dailySummary) return null;

    const targetDate =
      date || new Date(Date.now() - 86400000).toISOString().split("T")[0];

    await this.ensureDir();
    const filepath = join(this.logPath, `daily-${targetDate}.md`);

    // Skip if already generated today (方案 A: file-exists gate)
    try {
      await access(filepath);
      return null; // Already exists
    } catch {
      // File doesn't exist, proceed
    }

    const content = await this.generateDailyReport(targetDate);
    await writeFile(filepath, content, "utf-8");

    return filepath;
  }

  /**
   * Create a report from extraction stats.
   */
  createReport(
    sessionKey: string,
    stats: ExtractionStats,
    highlights: string[],
    user: string,
  ): MemoryChangeReport {
    return {
      timestamp: Date.now(),
      sessionKey,
      changes: stats,
      highlights,
      user,
    };
  }
}
