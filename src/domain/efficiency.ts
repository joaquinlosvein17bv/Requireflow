import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import { isoDaysAgo, nowIso, startOfUtcDay } from "./time.ts";

export interface EfficiencyMetrics {
  projectId: string;
  totalCompleted: number;
  totalActive: number;
  avgCycleTimeSeconds: number;
  formattedAvgCycleTime: string;
  avgLeadTimeSeconds: number;
  formattedAvgLeadTime: string;
  bugfixVelocitySeconds: number;
  formattedBugfixVelocity: string;
  distribution: {
    feature: number;
    bugfix: number;
    chore: number;
    refactor: number;
    debt: number;
  };
  throughput: {
    today: number;
    thisWeek: number;
    allTime: number;
  };
  dailyTrends: Array<{
    date: string;
    completedCount: number;
  }>;
  timeWindowDays: number;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0 || !Number.isFinite(seconds)) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.slice(0, 2).join(" ");
}

interface CycleRow {
  task_id: string;
  started_at: string;
  completed_at: string;
  cycle_time_seconds: number;
  type: string;
  task_created_at: string;
}

/** Daily series for the requested window, including days without completions. */
function buildDailyTrends(cycles: CycleRow[], days: number, now: Date): Array<{ date: string; completedCount: number }> {
  const counts = new Map<string, number>();
  for (const cycle of cycles) {
    const key = cycle.completed_at.slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const series: Array<{ date: string; completedCount: number }> = [];
  const totalDays = Math.min(Math.max(Math.trunc(days), 1), 90);
  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const date = isoDaysAgo(offset, now).slice(0, 10);
    series.push({ date, completedCount: counts.get(date) ?? 0 });
  }
  return series;
}

/**
 * Metrics are computed from `task_cycles`, one row per completion, so reopening
 * a task adds a cycle instead of overwriting the previous duration. All window
 * bounds are ISO strings compared against ISO strings — never against SQLite's
 * space-separated `datetime()`, whose `'T' > ' '` ordering used to include
 * completions up to a day outside the requested window (RF-11, RF-22).
 */
export function calculateProjectMetrics(
  projectId: string,
  timeWindowDays: number = 30,
  db: Database = getDatabase()
): EfficiencyMetrics {
  const now = new Date();
  const nowStamp = nowIso();
  const windowStart = isoDaysAgo(timeWindowDays, now);
  const todayStart = startOfUtcDay(now);
  const weekStart = isoDaysAgo(7, now);

  const cycles = db
    .query(`
      SELECT c.task_id,
             c.started_at,
             c.completed_at,
             c.cycle_time_seconds,
             t.type,
             t.created_at AS task_created_at
        FROM task_cycles c
        JOIN tasks t ON t.id = c.task_id
       WHERE c.project_id = ?
         AND c.completed_at >= ?
         AND c.completed_at <= ?
    `)
    .all(projectId, windowStart, nowStamp) as CycleRow[];

  const activeCountRow = db
    .query(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE project_id = ? AND status IN ('backlog', 'todo', 'in_progress')
    `)
    .get(projectId) as { count: number };

  const totalActive = Number(activeCountRow?.count || 0);
  const totalCompleted = cycles.length;

  let totalCycleSecs = 0;
  let totalLeadSecs = 0;
  let totalBugfixCycleSecs = 0;
  let bugfixCount = 0;

  const distribution = {
    feature: 0,
    bugfix: 0,
    chore: 0,
    refactor: 0,
    debt: 0,
  };

  for (const cycle of cycles) {
    totalCycleSecs += cycle.cycle_time_seconds;

    const normalizedType = cycle.type === "fix" ? "bugfix" : cycle.type;
    if (normalizedType in distribution) {
      distribution[normalizedType as keyof typeof distribution] += 1;
    } else {
      distribution.feature += 1;
    }

    if (cycle.type === "fix" || cycle.type === "bugfix") {
      totalBugfixCycleSecs += cycle.cycle_time_seconds;
      bugfixCount += 1;
    }

    const leadMs = Date.parse(cycle.completed_at) - Date.parse(cycle.task_created_at);
    if (Number.isFinite(leadMs)) {
      totalLeadSecs += Math.round(leadMs / 1000);
    }
  }

  const avgCycleTimeSeconds = totalCompleted > 0 ? Math.round(totalCycleSecs / totalCompleted) : 0;
  const avgLeadTimeSeconds = totalCompleted > 0 ? Math.round(totalLeadSecs / totalCompleted) : 0;
  const bugfixVelocitySeconds = bugfixCount > 0 ? Math.round(totalBugfixCycleSecs / bugfixCount) : 0;

  const countSince = (boundary: string): number => {
    const row = db
      .query(
        `SELECT COUNT(*) as count
           FROM task_cycles
          WHERE project_id = ? AND completed_at >= ? AND completed_at <= ?`
      )
      .get(projectId, boundary, nowStamp) as { count: number };
    return Number(row?.count || 0);
  };

  const allTimeRow = db
    .query("SELECT COUNT(*) as count FROM task_cycles WHERE project_id = ?")
    .get(projectId) as { count: number };

  return {
    projectId,
    totalCompleted,
    totalActive,
    avgCycleTimeSeconds,
    formattedAvgCycleTime: formatDuration(avgCycleTimeSeconds),
    avgLeadTimeSeconds,
    formattedAvgLeadTime: formatDuration(avgLeadTimeSeconds),
    bugfixVelocitySeconds,
    formattedBugfixVelocity: formatDuration(bugfixVelocitySeconds),
    distribution,
    throughput: {
      today: countSince(todayStart),
      thisWeek: countSince(weekStart),
      allTime: Number(allTimeRow?.count || 0),
    },
    dailyTrends: buildDailyTrends(cycles, timeWindowDays, now),
    timeWindowDays,
  };
}
