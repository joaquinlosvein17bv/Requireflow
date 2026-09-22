import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";

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

export function calculateProjectMetrics(
  projectId: string,
  timeWindowDays: number = 30,
  db: Database = getDatabase()
): EfficiencyMetrics {
  const completedTasks = db
    .query(`
      SELECT 
        id, type, created_at, started_at, completed_at, cycle_time_seconds
      FROM tasks
      WHERE project_id = ? 
        AND status IN ('done', 'archived')
        AND completed_at IS NOT NULL
        AND completed_at >= datetime('now', '-' || ? || ' days')
    `)
    .all(projectId, timeWindowDays) as Array<{
      id: string;
      type: string;
      created_at: string;
      started_at: string | null;
      completed_at: string;
      cycle_time_seconds: number | null;
    }>;

  const activeCountRow = db
    .query(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE project_id = ? AND status IN ('backlog', 'todo', 'in_progress')
    `)
    .get(projectId) as { count: number };

  const totalActive = Number(activeCountRow?.count || 0);
  const totalCompleted = completedTasks.length;

  let totalCycleSecs = 0;
  let cycleCount = 0;
  let totalLeadSecs = 0;
  let leadCount = 0;
  let totalBugfixCycleSecs = 0;
  let bugfixCount = 0;

  const distribution = {
    feature: 0,
    bugfix: 0,
    chore: 0,
    refactor: 0,
    debt: 0,
  };

  for (const t of completedTasks) {
    const normType = t.type === "fix" ? "bugfix" : (t.type as keyof typeof distribution);
    if (distribution[normType] !== undefined) {
      distribution[normType]++;
    } else {
      distribution.feature++;
    }

    if (t.started_at && t.completed_at) {
      const cycle = t.cycle_time_seconds ?? Math.max(0, Math.round(
        (new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()) / 1000
      ));
      totalCycleSecs += cycle;
      cycleCount++;

      if (t.type === "fix" || t.type === "bugfix") {
        totalBugfixCycleSecs += cycle;
        bugfixCount++;
      }
    }

    if (t.created_at && t.completed_at) {
      const lead = Math.max(0, Math.round(
        (new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / 1000
      ));
      totalLeadSecs += lead;
      leadCount++;
    }
  }

  const avgCycleTimeSeconds = cycleCount > 0 ? Math.round(totalCycleSecs / cycleCount) : 0;
  const avgLeadTimeSeconds = leadCount > 0 ? Math.round(totalLeadSecs / leadCount) : 0;
  const bugfixVelocitySeconds = bugfixCount > 0 ? Math.round(totalBugfixCycleSecs / bugfixCount) : 0;

  const todayCountRow = db
    .query(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE project_id = ? 
        AND status IN ('done', 'archived')
        AND completed_at >= date('now', 'start of day')
    `)
    .get(projectId) as { count: number };

  const weekCountRow = db
    .query(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE project_id = ? 
        AND status IN ('done', 'archived')
        AND completed_at >= date('now', '-7 days')
    `)
    .get(projectId) as { count: number };

  const allTimeCountRow = db
    .query(`
      SELECT COUNT(*) as count 
      FROM tasks 
      WHERE project_id = ? AND status IN ('done', 'archived')
    `)
    .get(projectId) as { count: number };

  // Daily trends for the last 7 days
  const trendsRows = db
    .query(`
      SELECT 
        date(completed_at) as comp_date,
        COUNT(*) as count
      FROM tasks
      WHERE project_id = ? 
        AND status IN ('done', 'archived')
        AND completed_at >= date('now', '-7 days')
      GROUP BY comp_date
      ORDER BY comp_date ASC
    `)
    .all(projectId) as Array<{ comp_date: string; count: number }>;

  const dailyTrends = trendsRows.map((r) => ({
    date: r.comp_date,
    completedCount: Number(r.count),
  }));

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
      today: Number(todayCountRow?.count || 0),
      thisWeek: Number(weekCountRow?.count || 0),
      allTime: Number(allTimeCountRow?.count || 0),
    },
    dailyTrends,
  };
}
