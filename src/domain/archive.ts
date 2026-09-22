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
  db: Database = getDatabase()
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

  const conditions: string[] = ["status = 'done'"];
  const params: any[] = [];

  if (projectId) {
    conditions.push("project_id = ?");
    params.push(projectId);
  }

  if (!forceManual) {
    const thresholdIso = new Date(Date.now() - projectThreshold * 3600 * 1000).toISOString();
    conditions.push("completed_at <= ?");
    params.push(thresholdIso);
  }

  const candidateQuery = `
    SELECT * FROM tasks 
    WHERE ${conditions.join(" AND ")}
  `;

  const candidates = db.query(candidateQuery).all(...params) as Task[];

  if (candidates.length === 0) {
    return { archivedCount: 0, taskIds: [] };
  }

  const archivedTaskIds: string[] = [];
  const now = new Date().toISOString();

  const insertHistoryStmt = db.prepare(`
    INSERT INTO history (
      id, task_id, project_id, section_id, title, description,
      type, priority, notes, tags, started_at, completed_at,
      archived_at, cycle_time_seconds, total_cycle_time_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        cycleSecs,
        totalMs
      );

      updateTaskStmt.run(now, task.id);
      archivedTaskIds.push(task.id);
    }
  })();

  return {
    archivedCount: archivedTaskIds.length,
    taskIds: archivedTaskIds,
  };
}
