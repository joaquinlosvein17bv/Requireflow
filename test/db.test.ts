import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../src/db/connection.ts";
import { Database } from "bun:sqlite";

describe("Database Storage Layer", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("should initialize schema and migration tables", () => {
    const migrations = db.query("SELECT * FROM _schema_migrations").all() as any[];
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0].version).toBe(1);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("projects");
    expect(names).toContain("sections");
    expect(names).toContain("tasks");
    expect(names).toContain("history");
    expect(names).toContain("config");
  });

  it("should enforce foreign key constraints", () => {
    expect(() => {
      db.run(
        "INSERT INTO tasks (id, project_id, title, type) VALUES ('t1', 'nonexistent', 'Task 1', 'feature')"
      );
    }).toThrow();

    // Now insert valid project
    db.run("INSERT INTO projects (id, name) VALUES ('p1', 'Project 1')");
    db.run("INSERT INTO tasks (id, project_id, title, type) VALUES ('t1', 'p1', 'Task 1', 'feature')");

    const task = db.query("SELECT * FROM tasks WHERE id = 't1'").get() as any;
    expect(task).toBeDefined();
    expect(task.title).toBe("Task 1");

    // Cascading delete
    db.run("DELETE FROM projects WHERE id = 'p1'");
    const deletedTask = db.query("SELECT * FROM tasks WHERE id = 't1'").get();
    expect(deletedTask).toBeNull();
  });

  it("should synchronize history with history_fts triggers and execute FTS5 search", () => {
    db.run("INSERT INTO projects (id, name) VALUES ('p1', 'Project 1')");
    db.run("INSERT INTO tasks (id, project_id, title, type) VALUES ('t1', 'p1', 'Task 1', 'feature')");

    db.run(`
      INSERT INTO history (id, task_id, project_id, title, description, type, priority, notes)
      VALUES ('h1', 't1', 'p1', 'Fix N+1 query in user list', 'Optimize database query with eager loading', 'bugfix', 'high', 'Resolved by adding join')
    `);

    // Verify FTS5 entry was created automatically by trigger
    const ftsResults = db
      .query("SELECT * FROM history_fts WHERE history_fts MATCH 'loading'")
      .all() as any[];
    expect(ftsResults.length).toBe(1);
    expect(ftsResults[0].id).toBe("h1");
    expect(ftsResults[0].title).toBe("Fix N+1 query in user list");

    const matchQuery = db
      .query("SELECT * FROM history_fts WHERE history_fts MATCH 'eager OR database'")
      .all() as any[];
    expect(matchQuery.length).toBe(1);

    // Test delete trigger
    db.run("DELETE FROM history WHERE id = 'h1'");
    const ftsAfterDelete = db
      .query("SELECT * FROM history_fts WHERE history_fts MATCH 'loading'")
      .all();
    expect(ftsAfterDelete.length).toBe(0);
  });
});
