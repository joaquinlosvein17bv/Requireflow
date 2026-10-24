import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { INITIAL_SCHEMA } from "../src/db/schema.ts";
import { MIGRATIONS, runMigrations } from "../src/db/migrations.ts";
import { normalizeRootPath } from "../src/domain/root-path.ts";

/** Builds a database exactly as version 1 shipped, with representative data. */
function buildV1Database(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON;");
  db.run(INITIAL_SCHEMA);
  db.run(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);
  db.run("INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial_schema_with_fts5')");

  db.run(
    "INSERT INTO projects (id, name, root_path) VALUES ('p1', 'backend', 'C:/repos/client-a/backend')"
  );
  db.run(
    "INSERT INTO projects (id, name, root_path) VALUES ('p2', 'frontend', 'C:/repos/client-b/frontend')"
  );
  db.run("INSERT INTO sections (id, project_id, name) VALUES ('s1', 'p1', 'Backend')");

  // A completed task with only SQLite-style timestamps and no cycle row.
  db.run(`
    INSERT INTO tasks (id, project_id, section_id, title, type, priority, status,
                       started_at, completed_at, cycle_time_seconds, created_at, updated_at)
    VALUES ('t1', 'p1', 's1', 'Old task', 'bugfix', 'high', 'done',
            '2026-01-01 10:00:00', '2026-01-01 10:30:00', 1800,
            '2026-01-01 09:00:00', '2026-01-01 10:30:00')
  `);
  db.run(`
    INSERT INTO tasks (id, project_id, title, type, status, position)
    VALUES ('t2', 'p2', 'Open task', 'feature', 'todo', 0)
  `);

  // Two history rows for the same task, as the old re-archive bug produced.
  db.run(`
    INSERT INTO history (id, task_id, project_id, title, type, priority, notes, archived_at)
    VALUES ('h1', 't1', 'p1', 'Old task', 'bugfix', 'high', 'first', '2026-01-02 10:00:00')
  `);
  db.run(`
    INSERT INTO history (id, task_id, project_id, title, type, priority, notes, archived_at)
    VALUES ('h2', 't1', 'p1', 'Old task', 'bugfix', 'high', 'second', '2026-01-03 10:00:00')
  `);

  return db;
}

describe("Versioned migrations (RF-24)", () => {
  it("applies every migration and preserves existing rows", () => {
    const db = buildV1Database();

    try {
      runMigrations(db);

      const versions = db.query("SELECT version FROM _schema_migrations ORDER BY version").all() as Array<{
        version: number;
      }>;
      expect(versions.map((row) => row.version)).toEqual(MIGRATIONS.map((m) => m.version));

      const projects = db.query("SELECT id, name, root_key FROM projects ORDER BY id").all() as Array<{
        id: string;
        name: string;
        root_key: string | null;
      }>;
      expect(projects.map((p) => p.id)).toEqual(["p1", "p2"]);
      expect(projects[0]?.root_key).toBe(normalizeRootPath("C:/repos/client-a/backend"));
      expect(projects[1]?.root_key).toBe(normalizeRootPath("C:/repos/client-b/frontend"));

      const tasks = db.query("SELECT COUNT(*) as c FROM tasks").get() as { c: number };
      expect(tasks.c).toBe(2);
    } finally {
      db.close();
    }
  });

  it("canonicalizes legacy timestamps", () => {
    const db = buildV1Database();

    try {
      runMigrations(db);

      const task = db
        .query("SELECT created_at, started_at, completed_at FROM tasks WHERE id = 't1'")
        .get() as { created_at: string; started_at: string; completed_at: string };

      for (const value of Object.values(task)) {
        expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    } finally {
      db.close();
    }
  });

  it("backfills one cycle per completed task", () => {
    const db = buildV1Database();

    try {
      runMigrations(db);

      const cycles = db.query("SELECT task_id, cycle_time_seconds FROM task_cycles").all() as Array<{
        task_id: string;
        cycle_time_seconds: number;
      }>;

      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.task_id).toBe("t1");
      expect(cycles[0]?.cycle_time_seconds).toBe(1800);
    } finally {
      db.close();
    }
  });

  it("collapses duplicate history and makes archival idempotent", () => {
    const db = buildV1Database();

    try {
      runMigrations(db);

      const rows = db.query("SELECT id, notes FROM history").all() as Array<{
        id: string;
        notes: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.notes).toBe("second");

      expect(() =>
        db.run(`
          INSERT INTO history (id, task_id, project_id, title, type, priority)
          VALUES ('h3', 't1', 'p1', 'Old task', 'bugfix', 'high')
        `)
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("is safe to run twice", () => {
    const db = buildV1Database();

    try {
      runMigrations(db);
      const first = db.query("SELECT COUNT(*) as c FROM _schema_migrations").get() as { c: number };
      const cycles = db.query("SELECT COUNT(*) as c FROM task_cycles").get() as { c: number };

      runMigrations(db);

      const second = db.query("SELECT COUNT(*) as c FROM _schema_migrations").get() as { c: number };
      const cyclesAfter = db.query("SELECT COUNT(*) as c FROM task_cycles").get() as { c: number };

      expect(second.c).toBe(first.c);
      expect(cyclesAfter.c).toBe(cycles.c);
    } finally {
      db.close();
    }
  });
});
