import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";
import { getSection } from "./section.ts";
import { nowIso, secondsBetween } from "./time.ts";
import { getProject } from "./project.ts";
import {
  assertTaskCanStart,
  assertTaskCreationAllowed,
  taskEligibility,
} from "./backlog/eligibility.ts";

export type TaskType = "feature" | "fix" | "bugfix" | "chore" | "refactor" | "debt";
export type TaskPriority = "low" | "medium" | "high" | "blocker";
export type TaskStatus = "backlog" | "todo" | "in_progress" | "done" | "archived";

export const TASK_TYPES: TaskType[] = [
  "feature",
  "fix",
  "bugfix",
  "chore",
  "refactor",
  "debt",
];
export const TASK_PRIORITIES: TaskPriority[] = ["low", "medium", "high", "blocker"];
export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "archived",
];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && TASK_TYPES.includes(value as TaskType);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

/** Raised when a task operation would break a domain invariant. */
export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

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
  work_item_id?: string | null;
  odd_task_ref?: string | null;
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
  workItemId?: string;
  oddTaskRef?: string;
}

export interface TaskFilterOptions {
  status?: TaskStatus | TaskStatus[];
  sectionId?: string;
  priority?: TaskPriority;
  type?: TaskType;
  excludeArchived?: boolean;
}

export const ELIGIBLE_STATUSES: TaskStatus[] = ["todo", "backlog"];

/**
 * Single ordering for the board and for "what is next": priority first, then the
 * position the user dragged the card to, then creation order and finally the id
 * so the result is stable when everything else ties.
 */
const TASK_ORDER_BY = `
  CASE t.priority 
    WHEN 'blocker' THEN 4 
    WHEN 'high' THEN 3 
    WHEN 'medium' THEN 2 
    WHEN 'low' THEN 1 
    ELSE 0 
  END DESC,
  t.position ASC,
  t.created_at ASC,
  t.id ASC
`;

/**
 * A section may only be referenced by tasks of the same project. The database
 * foreign key only proves the section exists, not which project owns it, so a
 * task could be filed under another project's section (RF-06).
 */
export function assertSectionBelongsToProject(
  sectionId: string,
  projectId: string,
  db: Database = getDatabase()
): void {
  const section = getSection(sectionId, db);
  if (!section) {
    throw new TaskValidationError(
      `Section not found with ID: ${sectionId}. Use the project's own section ids from the sections endpoint.`
    );
  }
  if (section.project_id !== projectId) {
    throw new TaskValidationError(
      `Section ${sectionId} does not belong to project ${projectId} (it belongs to ${section.project_id}).`
    );
  }
}

export function createTask(
  data: CreateTaskInput,
  db: Database = getDatabase()
): Task {
  if (data.sectionId) {
    assertSectionBelongsToProject(data.sectionId, data.projectId, db);
  }

  const project = getProject(data.projectId, db);
  if (!project) {
    throw new TaskValidationError(`Project not found with ID: ${data.projectId}`);
  }
  assertTaskCreationAllowed(project, data.workItemId, db);

  const id = crypto.randomUUID();
  const type = data.type || "feature";
  const priority = data.priority || "medium";
  const status = data.status || "todo";
  const tagsStr = Array.isArray(data.tags) ? data.tags.join(",") : data.tags || null;
  const timestamp = nowIso();

  let pos = data.position;
  const insert = (): void => {
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
        status, position, story_points, tags, notes, work_item_id, odd_task_ref,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.workItemId ?? null,
        data.oddTaskRef ?? null,
        timestamp,
        timestamp,
      ]
    );
  };

  // `MAX(position)+1` must be evaluated under a write lock, otherwise two
  // concurrent agent inserts read the same maximum and share a position.
  db.transaction(insert).immediate();

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
    ORDER BY ${TASK_ORDER_BY}
  `;

  return db.query(query).all(...params) as Task[];
}

export interface BlockedTask {
  id: string;
  title: string;
  reason: string;
}

export interface NextTaskDecision {
  nextTask: Task | null;
  blocked: BlockedTask[];
}

/**
 * Returns the first eligible task plus an explicit reason for every task that
 * was skipped. An agent must be able to explain a block instead of inventing
 * work to escape it.
 */
export function getNextTaskDecision(
  projectId: string,
  sectionId?: string,
  db: Database = getDatabase()
): NextTaskDecision {
  const project = getProject(projectId, db);
  if (!project) {
    return { nextTask: null, blocked: [] };
  }

  const statusPlaceholders = ELIGIBLE_STATUSES.map(() => "?").join(", ");
  const conditions: string[] = [
    "t.project_id = ?",
    `t.status IN (${statusPlaceholders})`,
  ];
  const params: any[] = [projectId, ...ELIGIBLE_STATUSES];

  if (sectionId) {
    conditions.push("t.section_id = ?");
    params.push(sectionId);
  }

  const candidates = db
    .query(
      `SELECT t.*, s.name as section_name, s.color as section_color
         FROM tasks t
         LEFT JOIN sections s ON t.section_id = s.id
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${TASK_ORDER_BY}`
    )
    .all(...params) as Task[];

  const blocked: BlockedTask[] = [];
  for (const task of candidates) {
    const eligibility = taskEligibility(task, project, db);
    if (eligibility.eligible) {
      return { nextTask: task, blocked: blocked.slice(0, 20) };
    }
    if (blocked.length < 20) {
      blocked.push({
        id: task.id,
        title: task.title,
        reason: eligibility.reason ?? "not eligible",
      });
    }
  }

  return { nextTask: null, blocked };
}

export function getNextTask(
  projectId: string,
  sectionId?: string,
  db: Database = getDatabase()
): Task | null {
  return getNextTaskDecision(projectId, sectionId, db).nextTask;
}

/**
 * Records one completed work cycle. Cycles are the single source of truth for
 * duration metrics: reopening a task appends a new cycle instead of
 * overwriting the previous duration (RF-09).
 */
export function recordCycle(
  taskId: string,
  projectId: string,
  startedAt: string,
  completedAt: string,
  cycleSeconds: number,
  db: Database = getDatabase()
): void {
  db.run(
    `INSERT INTO task_cycles (id, task_id, project_id, started_at, completed_at, cycle_time_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), taskId, projectId, startedAt, completedAt, cycleSeconds, completedAt]
  );
}

/** Legal status transitions. Anything else is a domain error, not a silent write. */
export const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo", "in_progress", "done"],
  todo: ["backlog", "in_progress", "done"],
  in_progress: ["backlog", "todo", "done"],
  done: ["backlog", "todo", "in_progress", "archived"],
  archived: ["backlog", "todo", "in_progress"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

interface TransitionPlan {
  fields: string[];
  values: any[];
  cycle: { startedAt: string; completedAt: string; cycleSeconds: number } | null;
}

/**
 * Builds the column changes for a status transition.
 *
 * Leaving a terminal state (`done`/`archived`) clears the completion metadata so
 * a reopened task never shows a stale duration or a `completed_at` while it is
 * being worked on. Past durations stay in `task_cycles`.
 */
function planTransition(current: Task, next: TaskStatus, at: string): TransitionPlan {
  if (next === current.status) {
    return { fields: [], values: [], cycle: null };
  }

  if (!canTransition(current.status, next)) {
    const allowed = LEGAL_TRANSITIONS[current.status];
    throw new TaskValidationError(
      `Illegal transition from '${current.status}' to '${next}' for task ${current.id}. Allowed next states: ${allowed.join(", ")}.`
    );
  }

  const plan: TransitionPlan = {
    fields: ["status = ?"],
    values: [next],
    cycle: null,
  };

  const isReopen =
    (current.status === "done" || current.status === "archived") &&
    next !== "done" &&
    next !== "archived";

  if (isReopen) {
    plan.fields.push("completed_at = ?", "archived_at = ?", "cycle_time_seconds = ?");
    plan.values.push(null, null, null);
  }

  if (next === "in_progress") {
    plan.fields.push("started_at = ?");
    plan.values.push(at);
  } else if (isReopen) {
    plan.fields.push("started_at = ?");
    plan.values.push(null);
  }

  if (next === "done") {
    const cycleSeconds = current.started_at
      ? secondsBetween(current.started_at, at)
      : 0;
    plan.fields.push("completed_at = ?", "cycle_time_seconds = ?");
    plan.values.push(at, cycleSeconds);
    plan.cycle = {
      startedAt: current.started_at ?? at,
      completedAt: at,
      cycleSeconds,
    };
  }

  if (next === "archived") {
    plan.fields.push("archived_at = ?");
    plan.values.push(at);
  }

  return plan;
}

export function startTask(
  taskId: string,
  db: Database = getDatabase()
): Task | null {
  const current = getTask(taskId, db);
  if (!current) return null;

  if (current.status !== "in_progress") {
    assertTaskCanStart(current, db);
  }

  const at = nowIso();
  const plan = planTransition(current, "in_progress", at);
  if (plan.fields.length === 0) {
    return current;
  }

  db.run(
    `UPDATE tasks SET ${plan.fields.join(", ")}, updated_at = ? WHERE id = ?`,
    [...plan.values, at, taskId]
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

  // Completing an already completed task is a no-op: it must not recalculate
  // the duration or append a second cycle for the same work.
  if (current.status === "done") {
    return current;
  }

  const completedAt = nowIso();
  const plan = planTransition(current, "done", completedAt);
  const updatedNotes = notes !== undefined ? notes : current.notes;

  db.transaction(() => {
    db.run(
      `UPDATE tasks SET ${plan.fields.join(", ")}, notes = ?, updated_at = ? WHERE id = ?`,
      [...plan.values, updatedNotes, completedAt, taskId]
    );

    if (plan.cycle) {
      recordCycle(
        taskId,
        current.project_id,
        plan.cycle.startedAt,
        plan.cycle.completedAt,
        plan.cycle.cycleSeconds,
        db
      );
    }
  })();

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
  let pendingCycle:
    | { startedAt: string; completedAt: string; cycleSeconds: number; projectId: string }
    | null = null;

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
    if (updates.section_id !== null) {
      assertSectionBelongsToProject(updates.section_id, current.project_id, db);
    }
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
    if (updates.status === "in_progress") {
      assertTaskCanStart(current, db);
    }
    const plan = planTransition(current, updates.status, nowIso());
    fields.push(...plan.fields);
    values.push(...plan.values);
    if (plan.cycle) {
      pendingCycle = {
        startedAt: plan.cycle.startedAt,
        completedAt: plan.cycle.completedAt,
        cycleSeconds: plan.cycle.cycleSeconds,
        projectId: current.project_id,
      };
    }
  }

  if (fields.length === 0) {
    return current;
  }

  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(taskId);

  db.transaction(() => {
    db.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, values);
    if (pendingCycle) {
      recordCycle(
        taskId,
        pendingCycle.projectId,
        pendingCycle.startedAt,
        pendingCycle.completedAt,
        pendingCycle.cycleSeconds,
        db
      );
    }
  })();

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
