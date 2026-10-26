import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INITIAL_SCHEMA } from "../src/db/schema.ts";
import { inspectDatabase } from "../src/db/connection.ts";
import { exportLegacyDatabase } from "../src/domain/legacy/export.ts";

/** Builds a realistic RequireFlow 1 database (schema v1 only). */
function legacyFixture(dir: string): string {
  const file = path.join(dir, "requireflow.db");
  const db = new Database(file);
  db.run("PRAGMA foreign_keys = ON");
  db.run(INITIAL_SCHEMA);
  db.run("INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial_schema_with_fts5')");

  db.run(
    `INSERT INTO projects (id, name, description, root_path, archive_threshold_hours, created_at, updated_at)
     VALUES ('p1', 'Cartas ⚡', 'Juego de cartas con acentos: ñandú', 'C:/proyectos/cartas', 24,
             '2026-01-01 10:00:00', '2026-01-02 10:00:00')`
  );
  db.run(
    `INSERT INTO sections (id, project_id, name, color, position) VALUES
     ('s1', 'p1', 'Backend', '#10b981', 0),
     ('s2', 'p1', 'UI', '#3b82f6', 1)`
  );
  db.run(
    `INSERT INTO tasks (id, project_id, section_id, title, description, type, priority, status,
                        position, story_points, tags, started_at, completed_at, notes, created_at, updated_at)
     VALUES ('t1', 'p1', 's1', 'Abrir carta', 'Debe abrir la carta elegida.\nSin excepciones.', 'feature', 'high', 'done',
             0, 3, 'core,ux', '2026-01-01 10:00:00', '2026-01-01 10:10:00', 'Implementado con tokens', '2026-01-01 09:00:00', '2026-01-01 10:10:00')`
  );
  db.run(
    `INSERT INTO tasks (id, project_id, title, description, type, priority, status, position, notes, created_at, updated_at)
     VALUES ('t2', 'p1', 'Reclamar carta', 'Pendiente de diseño', 'feature', 'medium', 'todo', 1, NULL, '2026-01-02 09:00:00', '2026-01-02 09:00:00')`
  );
  db.run(
    `INSERT INTO history (id, task_id, project_id, section_id, title, description, type, priority,
                          notes, tags, started_at, completed_at, archived_at, cycle_time_seconds)
     VALUES ('h1', 't1', 'p1', 's1', 'Abrir carta', 'Debe abrir la carta elegida.', 'feature', 'high',
             'Implementado con tokens', 'core,ux', '2026-01-01 10:00:00', '2026-01-01 10:10:00', '2026-01-03 10:00:00', 600)`
  );
  db.close();
  return file;
}

describe("Legacy v1 -> Markdown export", () => {
  const tempDirs: string[] = [];

  function tempDir(label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rf-${label}-`));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      removeWithRetry(dir);
    }
  });

  function removeWithRetry(target: string): void {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        return;
      } catch {
        Bun.sleepSync(25);
      }
    }
  }

  it("exports every row and verifies the export against the snapshot", () => {
    const source = legacyFixture(tempDir("legacy-src"));
    const outDir = tempDir("legacy-out");

    const result = exportLegacyDatabase({ sourcePath: source, outDir });

    expect(result.schemaVersion).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.integrity).toBe("ok");
    expect(result.counts).toEqual({
      projects: 1,
      sections: 2,
      tasks: 2,
      history: 1,
      config: 0,
    });
    expect(result.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes a readable index, per-project files and a structured backup", () => {
    const source = legacyFixture(tempDir("legacy-src"));
    const outDir = tempDir("legacy-out");

    const result = exportLegacyDatabase({ sourcePath: source, outDir });
    const index = fs.readFileSync(result.indexPath, "utf8");
    const json = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));

    expect(index).toContain("RequireFlow — Legacy database export");
    expect(index).toContain("Cartas ⚡");
    expect(index).toContain("Juego de cartas con acentos: ñandú");
    expect(index).toContain("Abrir carta");
    expect(index).toContain("Debe abrir la carta elegida.");
    expect(index).toContain("Implementado con tokens");
    expect(index).toContain("core,ux");
    expect(index).toContain("Detected schema version:** v1");
    expect(index).toContain("VACUUM INTO");

    expect(json.projects).toHaveLength(1);
    expect(json.projects[0].tasks.map((task: any) => task.id)).toEqual(["t1", "t2"]);
    expect(json.projects[0].history[0].id).toBe("h1");
    expect(json.counts.tasks).toBe(2);

    expect(result.projectFiles).toHaveLength(1);
    expect(fs.existsSync(result.projectFiles[0]!)).toBe(true);
  });

  it("marks V2-only fields as not recorded instead of inventing them", () => {
    const source = legacyFixture(tempDir("legacy-src"));
    const outDir = tempDir("legacy-out");

    const result = exportLegacyDatabase({ sourcePath: source, outDir });
    const json = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));

    expect(json.notRecorded).toContain("projects.root_key");
    expect(json.notRecorded).toContain("projects.mode");
    expect(json.notRecorded).toContain("tasks.work_item_id");
    expect(json.notRecorded).toContain("history.section_name");
  });

  it("never migrates the source database", () => {
    const source = legacyFixture(tempDir("legacy-src"));
    const outDir = tempDir("legacy-out");

    const before = inspectDatabase(source);
    exportLegacyDatabase({ sourcePath: source, outDir });
    const after = inspectDatabase(source);

    expect(before.schemaVersion).toBe(1);
    expect(after.schemaVersion).toBe(1);
    expect(after.isLegacy).toBe(true);

    const db = new Database(source, { readonly: true });
    try {
      const cycles = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_cycles'")
        .all();
      expect(cycles).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses to overwrite an existing export without force", () => {
    const source = legacyFixture(tempDir("legacy-src"));
    const outDir = tempDir("legacy-out");

    exportLegacyDatabase({ sourcePath: source, outDir });

    expect(() => exportLegacyDatabase({ sourcePath: source, outDir })).toThrow(
      /already exists/
    );

    const forced = exportLegacyDatabase({ sourcePath: source, outDir, force: true });
    expect(forced.verified).toBe(true);
  });

  it("fails clearly when the source does not exist", () => {
    const outDir = tempDir("legacy-out");
    expect(() =>
      exportLegacyDatabase({ sourcePath: path.join(outDir, "missing.db"), outDir })
    ).toThrow(/not found/);
  });
});
