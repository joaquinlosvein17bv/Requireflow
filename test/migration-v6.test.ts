import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { INITIAL_SCHEMA } from "../src/db/schema.ts";
import { runMigrations } from "../src/db/migrations.ts";

/**
 * The live database of a real user can still be at schema v1: the earlier
 * remediation report validated its migrations on a copy, never on the file in
 * use. This test pins the exact upgrade path from that shape.
 */
describe("Migration v1 -> v6 on a legacy database", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.run(INITIAL_SCHEMA);
    db.run("INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial_schema_with_fts5')");

    db.run(
      "INSERT INTO projects (id, name, description, root_path, archive_threshold_hours) VALUES ('p1', 'Cards', NULL, 'C:/tmp/cards', 24)"
    );
    db.run(
      "INSERT INTO sections (id, project_id, name, color, position) VALUES ('s1', 'p1', 'Backend', '#10b981', 0)"
    );
    db.run(
      `INSERT INTO tasks (id, project_id, section_id, title, type, priority, status, position, started_at, completed_at)
       VALUES ('t1', 'p1', 's1', 'Abrir carta', 'feature', 'high', 'done', 0, '2026-01-01 10:00:00', '2026-01-01 10:10:00')`
    );
    db.run(
      `INSERT INTO tasks (id, project_id, title, type, priority, status, position)
       VALUES ('t2', 'p1', 'Reclamar carta', 'feature', 'medium', 'todo', 1)`
    );
    db.run(
      `INSERT INTO history (id, task_id, project_id, section_id, title, type, priority, archived_at)
       VALUES ('h1', 't1', 'p1', 's1', 'Abrir carta', 'feature', 'high', '2026-01-02 10:00:00')`
    );
  });

  afterEach(() => {
    db.close();
  });

  it("applies every pending migration and preserves every existing row", () => {
    const beforeTasks = db.query("SELECT id, title, status FROM tasks ORDER BY id").all();
    const beforeProjects = db.query("SELECT id, name, root_path FROM projects").all();
    const beforeHistory = db.query("SELECT id, title, task_id FROM history").all();

    runMigrations(db);

    expect(beforeTasks).toEqual(
      db.query("SELECT id, title, status FROM tasks ORDER BY id").all()
    );
    expect(beforeProjects).toEqual(
      db.query("SELECT id, name, root_path FROM projects").all()
    );
    expect(beforeHistory).toEqual(
      db.query("SELECT id, title, task_id FROM history").all()
    );
  });

  it("adds the v6 planning tables and columns without rewriting existing meaning", () => {
    runMigrations(db);

    const version = db
      .query("SELECT MAX(version) v FROM _schema_migrations")
      .get() as { v: number };
    expect(Number(version.v)).toBe(8);

    const tables = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain("work_items");
    expect(tables).toContain("change_log");
    expect(tables).toContain("idempotency_keys");

    const project = db.query("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(project.mode).toBe("legacy");
    expect(project.root_key).toBe("c:/tmp/cards");

    const tasks = db.query("SELECT * FROM tasks ORDER BY id").all() as any[];
    expect(tasks[0].work_item_id).toBeNull();
    expect(tasks[0].odd_task_ref).toBeNull();
    expect(tasks[0].status).toBe("done");
  });

  it("backfills one cycle per completed task and keeps existing status untouched", () => {
    runMigrations(db);

    const cycles = db.query("SELECT * FROM task_cycles").all() as any[];
    expect(cycles).toHaveLength(1);
    expect(cycles[0].task_id).toBe("t1");
    expect(cycles[0].cycle_time_seconds).toBe(600);

    const todo = db.query("SELECT * FROM tasks WHERE id = 't2'").get() as any;
    expect(todo.status).toBe("todo");
    expect(todo.completed_at).toBeNull();
  });

  it("keeps the FTS index in sync with the preserved history row", () => {
    runMigrations(db);

    const hits = db
      .query(
        "SELECT h.id FROM history h JOIN history_fts f ON f.id = h.id WHERE history_fts MATCH 'Abrir*' LIMIT 5"
      )
      .all() as Array<{ id: string }>;

    expect(hits.map((hit) => hit.id)).toContain("h1");
  });

  it("passes an integrity check after upgrading", () => {
    runMigrations(db);
    const integrity = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    expect(integrity[0]?.integrity_check).toBe("ok");
  });
});
