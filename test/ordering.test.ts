import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import { createTask, getNextTask, listTasks, updateTask } from "../src/domain/task.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Next task selection and ordering (RF-13, RF-16)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("selects an eligible backlog task", () => {
    const project = createProject({ name: "Backlog" }, db);
    const task = createTask(
      { projectId: project.id, title: "from backlog", status: "backlog" },
      db
    );

    const next = getNextTask(project.id, undefined, db);
    expect(next?.id).toBe(task.id);
    expect(next?.status).toBe("backlog");
  });

  it("prefers priority over position", () => {
    const project = createProject({ name: "Priority" }, db);
    const low = createTask({ projectId: project.id, title: "low", priority: "low" }, db);
    const blocker = createTask(
      { projectId: project.id, title: "blocker", priority: "blocker" },
      db
    );
    updateTask(low.id, { position: -10 }, db);

    expect(getNextTask(project.id, undefined, db)?.id).toBe(blocker.id);
  });

  it("respects the board order when priority ties", () => {
    const project = createProject({ name: "Order" }, db);
    const first = createTask({ projectId: project.id, title: "first" }, db);
    const second = createTask({ projectId: project.id, title: "second" }, db);

    // The user drags the second card above the first one.
    updateTask(second.id, { position: -1 }, db);

    const boardFirst = listTasks(project.id, { status: "todo" }, db)[0];
    const next = getNextTask(project.id, undefined, db);

    expect(boardFirst?.id).toBe(second.id);
    expect(next?.id).toBe(second.id);
    expect(next?.id).not.toBe(first.id);
  });

  it("breaks complete ties deterministically", () => {
    const project = createProject({ name: "Ties" }, db);
    const a = createTask({ projectId: project.id, title: "a" }, db);
    const b = createTask({ projectId: project.id, title: "b" }, db);

    db.run("UPDATE tasks SET position = 0, created_at = '2026-01-01T00:00:00.000Z'", []);

    const next = getNextTask(project.id, undefined, db);
    const expected = [a.id, b.id].sort()[0];
    expect(next?.id).toBe(expected);

    // Stable across calls.
    expect(getNextTask(project.id, undefined, db)?.id).toBe(next?.id);
  });

  it("assigns unique positions under concurrent inserts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-concurrency-"));
    const dbPath = path.join(dir, "requireflow.db");

    const setup = createDatabase(dbPath);
    const project = createProject({ name: "Concurrent" }, setup);
    setup.close();

    const fixture = path.resolve(import.meta.dir, "fixtures", "insert-tasks.ts");
    const workers = ["alpha", "beta", "gamma"].map((prefix) =>
      Bun.spawn(["bun", "run", fixture, dbPath, project.id, prefix, "8"], {
        stdout: "ignore",
        stderr: "pipe",
      })
    );

    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
    expect(errors.filter((text) => text.trim() !== "")).toEqual([]);
    for (const code of exitCodes) {
      expect(code).toBe(0);
    }

    const verify = createDatabase(dbPath);
    const tasks = verify
      .query("SELECT position FROM tasks WHERE project_id = ? AND status = 'todo'")
      .all(project.id) as Array<{ position: number }>;

    expect(tasks).toHaveLength(24);
    const positions = tasks.map((task) => task.position);
    expect(new Set(positions).size).toBe(24);

    verify.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(25);
      }
    }
  }, 30_000);
});
