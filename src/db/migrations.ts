import { Database } from "bun:sqlite";
import { INITIAL_SCHEMA } from "./schema.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema_with_fts5",
    sql: INITIAL_SCHEMA,
  },
];

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );
  `);

  const appliedRows = db.query("SELECT version FROM _schema_migrations").all() as { version: number }[];
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      db.transaction(() => {
        db.run(migration.sql);
        db.run(
          "INSERT INTO _schema_migrations (version, name) VALUES (?, ?)",
          [migration.version, migration.name]
        );
      })();
    }
  }
}
