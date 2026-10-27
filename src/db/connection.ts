import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./migrations.ts";

const databases = new Map<string, Database>();

/** Highest schema version this build understands. */
export const V2_SCHEMA_VERSION = 7;

/** The historical, never-auto-migrated RequireFlow 1 database. */
export function legacyDbPath(): string {
  return path.join(os.homedir(), ".requireflow", "requireflow.db");
}

/** Default RequireFlow 2 database. Always a different file from the legacy one. */
export function v2DbPath(): string {
  return path.join(os.homedir(), ".requireflow", "v2", "requireflow.db");
}

/**
 * Raised when a command would open a pre-V2 database.
 *
 * RequireFlow 2 never upgrades a user's live v1 file behind their back: that
 * data is exported to Markdown instead, and the new application runs on a new,
 * clearly identified database.
 */
export class LegacyDatabaseError extends Error {
  readonly dbPath: string;
  readonly detectedVersion: number;

  constructor(dbPath: string, detectedVersion: number) {
    super(
      `Refusing to open "${dbPath}": detected schema version ${detectedVersion}, which is older than RequireFlow 2 (v${V2_SCHEMA_VERSION}). ` +
        `RequireFlow 2 does not migrate a live legacy database automatically. ` +
        `Export it first with: requireflow legacy export --source "${dbPath}" --out legacy-export. ` +
        `The V2 database lives at "${v2DbPath()}" (override with REQUIREFLOW_V2_DB_PATH).`
    );
    this.name = "LegacyDatabaseError";
    this.dbPath = dbPath;
    this.detectedVersion = detectedVersion;
  }
}

export function resolveDbPath(customPath?: string): string {
  if (customPath) {
    return customPath;
  }
  if (process.env.REQUIREFLOW_V2_DB_PATH) {
    return process.env.REQUIREFLOW_V2_DB_PATH;
  }
  // Kept for tests and scripts. It is validated below, so pointing it at a v1
  // file fails loudly instead of silently writing into the old database.
  if (process.env.REQUIREFLOW_DB_PATH) {
    return process.env.REQUIREFLOW_DB_PATH;
  }
  return v2DbPath();
}

export function ensureDbDirectory(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export interface DatabaseInspection {
  path: string;
  exists: boolean;
  sizeBytes: number;
  hasUserTables: boolean;
  /** True when the file carries RequireFlow 2 structures (work_items / projects.mode). */
  isV2: boolean;
  schemaVersion: number;
  isLegacy: boolean;
}

/** Reads the on-disk schema without opening the database for writing. */
export function inspectDatabase(dbPath: string): DatabaseInspection {
  if (dbPath === ":memory:") {
    return {
      path: dbPath,
      exists: false,
      sizeBytes: 0,
      hasUserTables: false,
      isV2: false,
      schemaVersion: 0,
      isLegacy: false,
    };
  }

  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    return {
      path: resolved,
      exists: false,
      sizeBytes: 0,
      hasUserTables: false,
      isV2: false,
      schemaVersion: 0,
      isLegacy: false,
    };
  }

  const sizeBytes = fs.statSync(resolved).size;
  if (sizeBytes === 0) {
    return {
      path: resolved,
      exists: true,
      sizeBytes,
      hasUserTables: false,
      isV2: false,
      schemaVersion: 0,
      isLegacy: false,
    };
  }

  const db = new Database(resolved, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'"
      )
      .all() as Array<{ name: string }>;

    const hasUserTables = tables.some((table) => table.name !== "_schema_migrations");
    let schemaVersion = 0;
    if (tables.some((table) => table.name === "_schema_migrations")) {
      const row = db
        .query("SELECT COALESCE(MAX(version), 0) v FROM _schema_migrations")
        .get() as { v: number } | null;
      schemaVersion = Number(row?.v ?? 0);
    }

    // A V2 database may be behind the current build (for example v6 when v7
    // exists). That is a normal internal upgrade, not a legacy v1 file: the v1
    // schema has neither work_items nor projects.mode.
    const hasWorkItems = tables.some((table) => table.name === "work_items");
    const projectColumns = tables.some((table) => table.name === "projects")
      ? (db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>)
      : [];
    const hasMode = projectColumns.some((column) => column.name === "mode");
    const isV2 = hasWorkItems || hasMode;

    return {
      path: resolved,
      exists: true,
      sizeBytes,
      hasUserTables,
      isV2,
      schemaVersion,
      isLegacy: hasUserTables && !isV2,
    };
  } finally {
    db.close();
  }
}

export function assertNotLegacyDatabase(dbPath: string): void {
  const inspection = inspectDatabase(dbPath);
  if (inspection.isLegacy) {
    throw new LegacyDatabaseError(inspection.path, inspection.schemaVersion);
  }
}

export function createDatabase(customPath?: string): Database {
  const dbPath = resolveDbPath(customPath);
  ensureDbDirectory(dbPath);
  assertNotLegacyDatabase(dbPath);

  const db = new Database(dbPath, { create: true });

  // Timeouts come first: switching to WAL and running migrations both need a
  // write lock, and a second process opening the database at the same moment
  // must wait instead of failing with SQLITE_BUSY.
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA foreign_keys = ON;");

  if (dbPath !== ":memory:") {
    db.run("PRAGMA journal_mode = WAL;");
  }

  runMigrations(db);
  return db;
}

/**
 * Returns the connection for a path, creating it on first use.
 *
 * Connections are cached per resolved path. The previous implementation kept a
 * single active connection and closed it whenever another path was requested,
 * so one consumer silently invalidated another consumer's handle (RF-17).
 */
export function getDatabase(customPath?: string): Database {
  const targetPath = resolveDbPath(customPath);
  const existing = databases.get(targetPath);
  if (existing) {
    return existing;
  }

  const created = createDatabase(targetPath);
  databases.set(targetPath, created);
  return created;
}

/**
 * Closes one cached connection, or every cached connection when no path is
 * given. Never closes a connection the caller did not ask to close.
 */
export function closeDatabase(customPath?: string): void {
  if (customPath === undefined) {
    for (const db of databases.values()) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.clear();
    return;
  }

  const targetPath = resolveDbPath(customPath);
  const db = databases.get(targetPath);
  if (!db) {
    return;
  }

  try {
    db.close();
  } catch {
    // already closed
  }
  databases.delete(targetPath);
}
