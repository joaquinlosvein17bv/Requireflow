import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./migrations.ts";

const databases = new Map<string, Database>();

export function resolveDbPath(customPath?: string): string {
  if (customPath) {
    return customPath;
  }
  if (process.env.REQUIREFLOW_DB_PATH) {
    return process.env.REQUIREFLOW_DB_PATH;
  }
  return path.join(os.homedir(), ".requireflow", "requireflow.db");
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

export function createDatabase(customPath?: string): Database {
  const dbPath = resolveDbPath(customPath);
  ensureDbDirectory(dbPath);

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
