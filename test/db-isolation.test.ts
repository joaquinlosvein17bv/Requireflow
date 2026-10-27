import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveDbPath,
  v2DbPath,
  legacyDbPath,
  inspectDatabase,
  createDatabase,
  LegacyDatabaseError,
  V2_SCHEMA_VERSION,
} from "../src/db/connection.ts";
import { INITIAL_SCHEMA } from "../src/db/schema.ts";

/**
 * RequireFlow 2 must never open, migrate or write into the user's v1 file.
 * These tests pin the physical separation and the loud failure.
 */
describe("V2 storage isolation from the legacy database", () => {
  const tempDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  /** Windows keeps WAL files locked for a few milliseconds after close. */
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

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-isolation-"));
    tempDirs.push(dir);
    return dir;
  }

  function legacyFixture(dir: string): string {
    const file = path.join(dir, "requireflow.db");
    const db = new Database(file);
    db.run(INITIAL_SCHEMA);
    db.run("INSERT INTO _schema_migrations (version, name) VALUES (1, 'initial_schema_with_fts5')");
    db.run("INSERT INTO projects (id, name) VALUES ('p1', 'Legacy project')");
    db.run("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'Legacy task')");
    db.close();
    return file;
  }

  beforeEach(() => {
    for (const key of ["REQUIREFLOW_DB_PATH", "REQUIREFLOW_V2_DB_PATH"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tempDirs.splice(0)) {
      removeWithRetry(dir);
    }
  });

  it("defaults to a V2 path that is a different file from the legacy database", () => {
    expect(resolveDbPath()).toBe(v2DbPath());
    expect(path.resolve(v2DbPath())).not.toBe(path.resolve(legacyDbPath()));
    expect(v2DbPath()).toContain(path.join(".requireflow", "v2"));
  });

  it("honours an explicit V2 override", () => {
    const custom = path.join(tempDir(), "custom-v2.db");
    process.env.REQUIREFLOW_V2_DB_PATH = custom;
    expect(resolveDbPath()).toBe(custom);
  });

  it("detects a legacy schema without opening it for writing", () => {
    const file = legacyFixture(tempDir());
    const before = fs.readFileSync(file);

    const inspection = inspectDatabase(file);

    expect(inspection.exists).toBe(true);
    expect(inspection.schemaVersion).toBe(1);
    expect(inspection.isLegacy).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses to open a legacy database and explains how to export it", () => {
    const file = legacyFixture(tempDir());

    let error: unknown;
    try {
      createDatabase(file);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(LegacyDatabaseError);
    expect((error as Error).message).toContain("legacy export");
    expect((error as Error).message).toContain(String(V2_SCHEMA_VERSION));

    // The refused database is byte-identical: nothing was migrated.
    const inspection = inspectDatabase(file);
    expect(inspection.schemaVersion).toBe(1);
    expect(inspection.isLegacy).toBe(true);
  });

  it("opens a fresh database at the V2 schema version", () => {
    const file = path.join(tempDir(), "fresh.db");
    const db = createDatabase(file);
    try {
      const row = db
        .query("SELECT MAX(version) v FROM _schema_migrations")
        .get() as { v: number };
      expect(Number(row.v)).toBe(V2_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("still supports in-memory databases used by tests", () => {
    const db = createDatabase(":memory:");
    try {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_items'")
        .all();
      expect(tables).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("allows an older V2 database to run its pending internal migrations", () => {
    const file = path.join(tempDir(), "v2-behind.db");
    const created = createDatabase(file);
    // Simulate a V2 file created by a previous build (schema v6).
    created.run("DELETE FROM _schema_migrations WHERE version = 7");
    created.close();

    const inspection = inspectDatabase(file);
    expect(inspection.schemaVersion).toBe(6);
    expect(inspection.isV2).toBe(true);
    expect(inspection.isLegacy).toBe(false);

    const upgraded = createDatabase(file);
    try {
      const row = upgraded
        .query("SELECT MAX(version) v FROM _schema_migrations")
        .get() as { v: number };
      expect(Number(row.v)).toBe(V2_SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
  });
});
