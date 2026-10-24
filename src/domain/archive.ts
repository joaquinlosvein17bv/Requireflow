import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";
import { getProject } from "./project.ts";
import type { Task } from "./task.ts";

export interface ArchiveResult {
  archivedCount: number;
  taskIds: string[];
}

export function archiveDoneTasks(
  projectId?: string,
  forceManual: boolean = false,
  thresholdHours?: number,
  db: Database = getDatabase(),
  now: Date = new Date()
): ArchiveResult {
  let projectThreshold = thresholdHours;
  if (projectThreshold === undefined && projectId) {
    const proj = getProject(projectId, db);
    if (proj) {
      projectThreshold = proj.archive_threshold_hours;
    }
  }
  if (projectThreshold === undefined) {
    projectThreshold = 24;
  }

  const conditions: string[] = ["t.status = 'done'"];
  const params: any[] = [];

  if (projectId) {
    conditions.push("t.project_id = ?");
    params.push(projectId);
  }

  if (!forceManual) {
    const thresholdIso = new Date(now.getTime() - projectThreshold * 3600 * 1000).toISOString();
    conditions.push("t.completed_at <= ?");
    params.push(thresholdIso);
  }

  const candidateQuery = `
    SELECT t.*, s.name as section_name, s.color as section_color
      FROM tasks t
      LEFT JOIN sections s ON t.section_id = s.id
     WHERE ${conditions.join(" AND ")}
  `;

  const candidates = db.query(candidateQuery).all(...params) as Task[];

  if (candidates.length === 0) {
    return { archivedCount: 0, taskIds: [] };
  }

  const archivedTaskIds: string[] = [];
  const nowIsoValue = now.toISOString();

  const insertHistoryStmt = db.prepare(`
    INSERT OR IGNORE INTO history (
      id, task_id, project_id, section_id, title, description,
      type, priority, notes, tags, started_at, completed_at,
      archived_at, cycle_time_seconds, total_cycle_time_ms,
      section_name, section_color
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateTaskStmt = db.prepare(`
    UPDATE tasks 
    SET status = 'archived', 
        archived_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  db.transaction(() => {
    for (const task of candidates) {
      const historyId = crypto.randomUUID();
      const cycleSecs = task.cycle_time_seconds ?? (
        task.started_at && task.completed_at
          ? Math.max(0, Math.round((new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()) / 1000))
          : null
      );
      const totalMs = cycleSecs !== null ? cycleSecs * 1000 : null;

      insertHistoryStmt.run(
        historyId,
        task.id,
        task.project_id,
        task.section_id,
        task.title,
        task.description,
        task.type,
        task.priority,
        task.notes,
        task.tags,
        task.started_at,
        task.completed_at,
        nowIsoValue,
        cycleSecs,
        totalMs,
        task.section_name ?? null,
        task.section_color ?? null
      );

      updateTaskStmt.run(nowIsoValue, task.id);
      archivedTaskIds.push(task.id);
    }
  })();

  return {
    archivedCount: archivedTaskIds.length,
    taskIds: archivedTaskIds,
  };
}

export interface AutoArchiveSummary {
  archivedCount: number;
  taskIds: string[];
  projectsChecked: number;
}

/**
 * Archival pass for every project using its configured threshold.
 *
 * RequireFlow is local-first and has no daemon, so this runs opportunistically:
 * once when a long-lived process starts (HTTP/MCP) and then on an interval, and
 * it catches up on the next start after a period with nothing running. It is
 * idempotent, so running it twice never duplicates history (RF-08).
 */
export function autoArchiveAllProjects(
  db: Database = getDatabase(),
  now: Date = new Date()
): AutoArchiveSummary {
  const projects = db.query("SELECT id, archive_threshold_hours FROM projects").all() as Array<{
    id: string;
    archive_threshold_hours: number;
  }>;

  let archivedCount = 0;
  const taskIds: string[] = [];

  for (const project of projects) {
    const result = archiveDoneTasks(
      project.id,
      false,
      project.archive_threshold_hours,
      db,
      now
    );
    archivedCount += result.archivedCount;
    taskIds.push(...result.taskIds);
  }

  return { archivedCount, taskIds, projectsChecked: projects.length };
}

/**
 * Starts the periodic archival pass. Returns a stop function.
 * The timer does not keep the process alive on its own.
 */
export function startAutoArchive(
  db: Database = getDatabase(),
  intervalMs: number = 60_000
): () => void {
  const run = (): void => {
    try {
      autoArchiveAllProjects(db);
    } catch (err) {
      console.error("[RequireFlow] Automatic archival failed:", err);
    }
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
