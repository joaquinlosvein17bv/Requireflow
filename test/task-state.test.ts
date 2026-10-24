import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import {
  createTask,
  getTask,
  updateTask,
  startTask,
  completeTask,
} from "../src/domain/task.ts";
import { archiveDoneTasks } from "../src/domain/archive.ts";
import { listHistory } from "../src/domain/history.ts";

function cycleCount(db: Database, taskId: string): number {
  const row = db
    .query("SELECT COUNT(*) as c FROM task_cycles WHERE task_id = ?")
    .get(taskId) as { c: number };
  return Number(row.c);
}

describe("Task state machine (RF-09)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("walks the normal path todo -> in_progress -> done", () => {
    const project = createProject({ name: "Flow" }, db);
    const task = createTask({ projectId: project.id, title: "flow" }, db);
    expect(task.status).toBe("todo");

    expect(startTask(task.id, db)?.status).toBe("in_progress");
    const done = completeTask(task.id, "ok", db);
    expect(done?.status).toBe("done");
    expect(done?.completed_at).not.toBeNull();
    expect(done?.archived_at).toBeNull();
    expect(cycleCount(db, task.id)).toBe(1);
  });

  it("treats a repeated completion as a no-op", () => {
    const project = createProject({ name: "Idempotent" }, db);
    const task = createTask({ projectId: project.id, title: "once" }, db);
    startTask(task.id, db);

    const first = completeTask(task.id, "first", db);
    const second = completeTask(task.id, "second", db);

    expect(second?.completed_at).toBe(first?.completed_at);
    expect(second?.notes).toBe("first");
    expect(cycleCount(db, task.id)).toBe(1);
  });

  it("reopens a completed task without keeping stale completion data", () => {
    const project = createProject({ name: "Reopen" }, db);
    const task = createTask({ projectId: project.id, title: "reopen" }, db);
    startTask(task.id, db);
    completeTask(task.id, "first", db);

    const reopened = startTask(task.id, db);
    expect(reopened?.status).toBe("in_progress");
    expect(reopened?.completed_at).toBeNull();
    expect(reopened?.archived_at).toBeNull();
    expect(reopened?.cycle_time_seconds).toBeNull();
    expect(reopened?.started_at).not.toBeNull();

    completeTask(task.id, "second", db);
    expect(cycleCount(db, task.id)).toBe(2);
  });

  it("restores an archived task without leaving archived_at set", () => {
    const project = createProject({ name: "Restore" }, db);
    const task = createTask({ projectId: project.id, title: "archived" }, db);
    completeTask(task.id, "done", db);
    archiveDoneTasks(project.id, true, 0, db);

    const archived = getTask(task.id, db);
    expect(archived?.status).toBe("archived");
    expect(archived?.archived_at).not.toBeNull();

    const restored = startTask(task.id, db);
    expect(restored?.status).toBe("in_progress");
    expect(restored?.archived_at).toBeNull();
    expect(restored?.completed_at).toBeNull();
  });

  it("rejects transitions that skip the lifecycle", () => {
    const project = createProject({ name: "Illegal" }, db);
    const task = createTask({ projectId: project.id, title: "skip" }, db);

    // todo -> archived is not legal: a task must be completed first.
    expect(() => updateTask(task.id, { status: "archived" }, db)).toThrow(
      /Illegal transition/
    );
    expect(getTask(task.id, db)?.status).toBe("todo");

    completeTask(task.id, "done", db);
    archiveDoneTasks(project.id, true, 0, db);

    // archived -> done is not legal either.
    expect(() => updateTask(task.id, { status: "done" }, db)).toThrow(
      /Illegal transition/
    );
  });

  it("treats setting the current status as a no-op", () => {
    const project = createProject({ name: "Same" }, db);
    const task = createTask({ projectId: project.id, title: "same" }, db);

    const updated = updateTask(task.id, { status: "todo" }, db);
    expect(updated?.status).toBe("todo");
    expect(updated?.completed_at).toBeNull();
    expect(cycleCount(db, task.id)).toBe(0);
  });
});

describe("History duplication (RF-10)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("keeps a single history row when the same task is archived twice", () => {
    const project = createProject({ name: "History" }, db);
    const task = createTask({ projectId: project.id, title: "twice" }, db);
    completeTask(task.id, "first", db);
    archiveDoneTasks(project.id, true, 0, db);

    // Force the task back to done and archive it again.
    db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [task.id]);
    const second = archiveDoneTasks(project.id, true, 0, db);
    expect(second.archivedCount).toBe(1);

    const page = listHistory(project.id, 1, 50, db);
    const rows = page.items.filter((item) => item.task_id === task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notes).toBe("first");
  });
});
