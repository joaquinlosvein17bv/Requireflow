import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import {
  createProject,
  getOrCreateProject,
  getProject,
  listProjects,
  normalizeRootPath,
  detectProject,
  findProjectsWithMissingRoots,
  resolveCurrentProject,
} from "../src/domain/project.ts";
import { createTask, listTasks } from "../src/domain/task.ts";
import { INITIAL_SCHEMA } from "../src/db/schema.ts";
import { runMigrations } from "../src/db/migrations.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Project identity by normalized root path (RF-01)", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("keeps two repositories with the same name isolated", () => {
    const first = getOrCreateProject("backend", "C:/repos/client-a/backend", db);
    const second = getOrCreateProject("backend", "C:/repos/client-b/backend", db);

    expect(first.id).not.toBe(second.id);
    expect(first.root_path).toBe("C:/repos/client-a/backend");
    expect(second.root_path).toBe("C:/repos/client-b/backend");

    const taskA = createTask({ projectId: first.id, title: "Cliente A" }, db);
    expect(listTasks(first.id, {}, db)).toHaveLength(1);
    expect(listTasks(second.id, {}, db)).toHaveLength(0);
    expect(taskA.project_id).toBe(first.id);
  });

  it("allows two projects to share a display name", () => {
    createProject({ name: "backend", rootPath: "C:/repos/one/backend" }, db);
    createProject({ name: "backend", rootPath: "C:/repos/two/backend" }, db);

    const matching = listProjects(db).filter((p) => p.name === "backend");
    expect(matching).toHaveLength(2);
  });

  it("recognises equivalent spellings of the same root path", () => {
    const first = getOrCreateProject("app", "C:/repos/app", db);
    const variants = ["C:/repos/app/", "C:\\repos\\app", "C://repos//app"];

    for (const variant of variants) {
      const same = getOrCreateProject("app", variant, db);
      expect(same.id).toBe(first.id);
    }
  });

  it("normalizes separators, trailing slashes and Windows casing", () => {
    const normalized = normalizeRootPath("C:\\Repos\\App\\");
    expect(normalized).not.toContain("\\");
    expect(normalized.endsWith("/")).toBe(false);

    if (process.platform === "win32") {
      expect(normalized).toBe(normalizeRootPath("c:/repos/app"));
    }
  });

  it("resolves a subdirectory to the project that owns the root", () => {
    const project = getOrCreateProject("app", "C:/repos/app", db);
    const nested = detectProject("C:/repos/app/src/domain", db);

    expect(nested.project?.id).toBe(project.id);
    expect(nested.isLinked).toBe(true);
  });

  it("never lets an umbrella project claim a nested checkout", () => {
    const umbrellaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rf-umbrella-"));
    const child = path.join(umbrellaRoot, "child-repo");
    fs.mkdirSync(path.join(child, ".git"), { recursive: true });
    fs.mkdirSync(path.join(child, "src"), { recursive: true });

    try {
      const umbrella = getOrCreateProject("umbrella", umbrellaRoot, db);
      const detection = detectProject(path.join(child, "src"), db);

      expect(detection.project?.id).not.toBe(umbrella.id);
      expect(detection.project).toBeNull();
    } finally {
      fs.rmSync(umbrellaRoot, { recursive: true, force: true });
    }
  });

  it("does not create a project when only detecting", () => {
    const before = listProjects(db).length;
    const detection = detectProject("C:/repos/unknown-place", db);

    expect(detection.project).toBeNull();
    expect(detection.isLinked).toBe(false);
    expect(listProjects(db).length).toBe(before);
    expect(listProjects(db).map((p) => p.root_path)).not.toContain("C:/repos/unknown-place");
  });

  it("claims an unlinked legacy project with the same unique name", () => {
    const legacy = createProject({ name: "order" }, db);
    expect(legacy.root_path).toBeNull();

    const resolved = resolveCurrentProject("C:/repos/order", db);
    expect(resolved.id).toBe(legacy.id);
    expect(normalizeRootPath(resolved.root_path ?? "")).toBe(
      normalizeRootPath("C:/repos/order")
    );
  });
});

describe("Project identity migration (RF-01)", () => {
  it("preserves existing rows and backfills root_key", () => {
    const db = createDatabase(":memory:");

    // Simulate a v1 database: schema only, one applied migration, real rows.
    const legacy = new Database(":memory:");
    legacy.run(INITIAL_SCHEMA);
    legacy.run(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    legacy.run("INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial_schema_with_fts5')");
    legacy.run("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'backend', 'C:/repos/a/backend')");
    legacy.run("INSERT INTO projects (id, name, root_path) VALUES ('p2', 'other', 'C:/repos/b/other')");
    legacy.run("INSERT INTO projects (id, name, root_path) VALUES ('p3', 'loose', NULL)");
    legacy.run("INSERT INTO tasks (id, project_id, title, type) VALUES ('t1', 'p1', 'Task', 'feature')");
    runMigrations(legacy);

    const rows = legacy
      .query("SELECT id, name, root_path, root_key FROM projects ORDER BY id")
      .all() as Array<{ id: string; name: string; root_path: string | null; root_key: string | null }>;

    expect(rows.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
    expect(rows.map((r) => r.name)).toEqual(["backend", "other", "loose"]);
    expect(rows[0]?.root_key).toBe(normalizeRootPath("C:/repos/a/backend"));
    expect(rows[1]?.root_key).toBe(normalizeRootPath("C:/repos/b/other"));
    expect(rows[2]?.root_key).toBeNull();
    expect(legacy.query("SELECT COUNT(*) as c FROM tasks").get()).toEqual({ c: 1 });

    legacy.close();
    db.close();
  });

  it("still finds a migrated project by its normalized path", () => {
    const legacy = new Database(":memory:");
    legacy.run(INITIAL_SCHEMA);
    legacy.run(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    legacy.run("INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial_schema_with_fts5')");
    legacy.run("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'backend', 'C:/repos/a/backend')");
    runMigrations(legacy);

    const found = getOrCreateProject("backend", "C:/repos/a/backend/", legacy);
    expect(found.id).toBe("p1");
    expect(getProject("p1", legacy)?.root_path).toBe("C:/repos/a/backend");
    legacy.close();
  });
});

describe("Collision detection for pre-existing data (RF-01)", () => {
  it("flags projects whose stored root no longer exists without splitting them", () => {
    const db = createDatabase(":memory:");
    const missing = path.join(os.tmpdir(), `rf-missing-${Date.now()}`, "backend");
    const existingDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-existing-"));

    try {
      const victim = createProject({ name: "backend", rootPath: missing }, db);
      const healthy = createProject({ name: "app", rootPath: existingDir }, db);
      const before = listProjects(db).length;

      const suspicious = findProjectsWithMissingRoots(db);

      expect(suspicious.map((p) => p.id)).toEqual([victim.id]);
      expect(suspicious.map((p) => p.id)).not.toContain(healthy.id);
      expect(listProjects(db).length).toBe(before);
    } finally {
      fs.rmSync(existingDir, { recursive: true, force: true });
      db.close();
    }
  });
});
