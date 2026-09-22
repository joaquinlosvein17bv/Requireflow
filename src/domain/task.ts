import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";

export type TaskType = "feature" | "fix" | "bugfix" | "chore" | "refactor" | "debt";
export type TaskPriority = "low" | "medium" | "high" | "blocker";
export type TaskStatus = "backlog" | "todo" | "in_progress" | "done" | "archived";

export interface Task {
  id: string;
  project_id: string;
  section_id: string | null;
  title: string;
  description: string | null;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  position: number;
  story_points: number | null;
  tags: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  cycle_time_seconds: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  section_name?: string | null;
  section_color?: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  sectionId?: string;
  type?: TaskType;
  priority?: TaskPriority;
  status?: TaskStatus;
  position?: number;
  storyPoints?: number;
  tags?: string[] | string;
  notes?: string;
}

export interface TaskFilterOptions {
  status?: TaskStatus | TaskStatus[];
  sectionId?: string;
  priority?: TaskPriority;
  type?: TaskType;
  excludeArchived?: boolean;
}

export function createTask(
  data: CreateTaskInput,
  db: Database = getDatabase()
): Task {
  const id = crypto.randomUUID();
  const type = data.type || "feature";
  const priority = data.priority || "medium";
  const status = data.status || "todo";
  const tagsStr = Array.isArray(data.tags) ? data.tags.join(",") : data.tags || null;

  let pos = data.position;
  if (pos === undefined) {
    const maxPosRow = db
      .query(
        "SELECT MAX(position) as max_pos FROM tasks WHERE project_id = ? AND status = ?"
      )
      .get(data.projectId, status) as { max_pos: number | null };
    pos = (maxPosRow?.max_pos ?? -1) + 1;
  }

  db.run(
    `INSERT INTO tasks (
      id, project_id, section_id, title, description, type, priority,
      status, position, story_points, tags, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.projectId,
      data.sectionId || null,
      data.title,
      data.description || null,
      type,
      priority,
      status,
      pos,
      data.storyPoints ?? null,
      tagsStr,
      data.notes || null,
    ]
  );

  return getTask(id, db)!;
}

export function getTask(
  id: string,
  db: Database = getDatabase()
): Task | null {
  return db
    .query(`
      SELECT t.*, s.name as section_name, s.color as section_color
      FROM tasks t
      LEFT JOIN sections s ON t.section_id = s.id
      WHERE t.id = ?
    `)
    .get(id) as Task | null;
}

export function listTasks(
  projectId: string,
  filters: TaskFilterOptions = {},
  db: Database = getDatabase()
): Task[] {
  const conditions: string[] = ["t.project_id = ?"];
  const params: any[] = [projectId];

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      const placeholders = filters.status.map(() => "?").join(", ");
      conditions.push(`t.status IN (${placeholders})`);
      params.push(...filters.status);
    } else {
      conditions.push("t.status = ?");
      params.push(filters.status);
    }
  } else if (filters.excludeArchived !== false) {
    conditions.push("t.status != 'archived'");
  }

  if (filters.sectionId) {
    conditions.push("t.section_id = ?");
    params.push(filters.sectionId);
  }

  if (filters.priority) {
    conditions.push("t.priority = ?");
    params.push(filters.priority);
  }

  if (filters.type) {
    conditions.push("t.type = ?");
    params.push(filters.type);
  }

  const query = `
    SELECT t.*, s.name as section_name, s.color as section_color
    FROM tasks t
    LEFT JOIN sections s ON t.section_id = s.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY 
      CASE t.priority 
        WHEN 'blocker' THEN 4 
        WHEN 'high' THEN 3 
        WHEN 'medium' THEN 2 
        WHEN 'low' THEN 1 
        ELSE 0 
      END DESC,
      t.position ASC,
      t.created_at ASC
  `;

  return db.query(query).all(...params) as Task[];
}

export function getNextTask(
  projectId: string,
  sectionId?: string,
  db: Database = getDatabase()
): Task | null {
  const conditions: string[] = ["t.project_id = ?", "t.status = 'todo'"];
  const params: any[] = [projectId];

  if (sectionId) {
    conditions.push("t.section_id = ?");
    params.push(sectionId);
  }

  const query = `
    SELECT t.*, s.name as section_name, s.color as section_color
    FROM tasks t
    LEFT JOIN sections s ON t.section_id = s.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY 
      CASE t.priority 
        WHEN 'blocker' THEN 4 
        WHEN 'high' THEN 3 
        WHEN 'medium' THEN 2 
        WHEN 'low' THEN 1 
        ELSE 0 
      END DESC,
      t.created_at ASC
    LIMIT 1
  `;

  return db.query(query).get(...params) as Task | null;
}

export function startTask(
  taskId: string,
  db: Database = getDatabase()
): Task | null {
  const current = getTask(taskId, db);
  if (!current) return null;

  const nowStr = new Date().toISOString();
  const startedAt = current.started_at || nowStr;

  db.run(
    `UPDATE tasks 
     SET status = 'in_progress', 
         started_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [startedAt, taskId]
  );

  return getTask(taskId, db);
}

export function completeTask(
  taskId: string,
  notes?: string,
  db: Database = getDatabase()
): Task | null {
  const current = getTask(taskId, db);
  if (!current) return null;

  const now = new Date();
  const completedAt = now.toISOString();

  let cycleTimeSeconds: number | null = current.cycle_time_seconds;
  if (current.started_at) {
    const started = new Date(current.started_at);
    cycleTimeSeconds = Math.max(0, Math.round((now.getTime() - started.getTime()) / 1000));
  }

  const updatedNotes = notes !== undefined ? notes : current.notes;

  db.run(
    `UPDATE tasks 
     SET status = 'done', 
         completed_at = ?,
         cycle_time_seconds = ?,
         notes = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [completedAt, cycleTimeSeconds, updatedNotes, taskId]
  );

  return getTask(taskId, db);
}

export function updateTask(
  taskId: string,
  updates: Partial<Pick<Task, "title" | "description" | "priority" | "type" | "section_id" | "status" | "position" | "story_points" | "tags" | "notes">>,
  db: Database = getDatabase()
): Task | null {
  const current = getTask(taskId, db);
  if (!current) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description);
  }
  if (updates.priority !== undefined) {
    fields.push("priority = ?");
    values.push(updates.priority);
  }
  if (updates.type !== undefined) {
    fields.push("type = ?");
    values.push(updates.type);
  }
  if (updates.section_id !== undefined) {
    fields.push("section_id = ?");
    values.push(updates.section_id);
  }
  if (updates.position !== undefined) {
    fields.push("position = ?");
    values.push(updates.position);
  }
  if (updates.story_points !== undefined) {
    fields.push("story_points = ?");
    values.push(updates.story_points);
  }
  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(updates.tags);
  }
  if (updates.notes !== undefined) {
    fields.push("notes = ?");
    values.push(updates.notes);
  }

  if (updates.status !== undefined && updates.status !== current.status) {
    fields.push("status = ?");
    values.push(updates.status);

    if (updates.status === "in_progress" && !current.started_at) {
      fields.push("started_at = ?");
      values.push(new Date().toISOString());
    } else if (updates.status === "done" && !current.completed_at) {
      const now = new Date();
      fields.push("completed_at = ?");
      values.push(now.toISOString());
      if (current.started_at) {
        const diffSecs = Math.max(0, Math.round((now.getTime() - new Date(current.started_at).getTime()) / 1000));
        fields.push("cycle_time_seconds = ?");
        values.push(diffSecs);
      }
    }
  }

  if (fields.length === 0) {
    return current;
  }

  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(taskId);

  db.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, values);
  return getTask(taskId, db);
}

export function deleteTask(taskId: string, db: Database = getDatabase()): boolean {
  const result = db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
  return result.changes > 0;
}

export function getKanbanBoard(
  projectId: string,
  sectionId?: string,
  db: Database = getDatabase()
): { todo: Task[]; in_progress: Task[]; done: Task[] } {
  const allTasks = listTasks(
    projectId,
    { status: ["todo", "in_progress", "done"], sectionId },
    db
  );

  const todo = allTasks.filter((t) => t.status === "todo");
  const in_progress = allTasks.filter((t) => t.status === "in_progress");
  const done = allTasks.filter((t) => t.status === "done");

  return { todo, in_progress, done };
}
