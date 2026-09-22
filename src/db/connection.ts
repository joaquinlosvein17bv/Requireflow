import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./migrations.ts";

let activeDb: Database | null = null;
let activeDbPath: string | null = null;

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

  if (dbPath !== ":memory:") {
    db.run("PRAGMA journal_mode = WAL;");
  }
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");

  runMigrations(db);
  return db;
}

export function getDatabase(customPath?: string): Database {
  const targetPath = resolveDbPath(customPath);
  if (!activeDb || activeDbPath !== targetPath) {
    if (activeDb) {
      activeDb.close();
    }
    activeDb = createDatabase(targetPath);
    activeDbPath = targetPath;
  }
  return activeDb;
}

export function closeDatabase(): void {
  if (activeDb) {
    try {
      activeDb.close();
    } catch {
      // already closed
    }
    activeDb = null;
    activeDbPath = null;
  }
}
