import { Database } from "bun:sqlite";
import { INITIAL_SCHEMA } from "./schema.ts";
import { normalizeRootPath } from "../domain/root-path.ts";

export interface Migration {
  version: number;
  name: string;
  /** Declarative migration, executed as a single statement batch. */
  sql?: string;
  /** Imperative migration, for data backfills that need JavaScript. */
  run?: (db: Database) => void;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

/**
 * Gives every project a stable identity derived from its normalized root path,
 * instead of the display name. Rows are preserved: the name stops being unique,
 * `root_key` is backfilled from `root_path`, and only projects that already
 * share a normalized root are detached (root_key = NULL) instead of being
 * merged or deleted.
 */
function migrateProjectIdentity(db: Database): void {
  db.run("DROP INDEX IF EXISTS idx_projects_name");
  db.run("CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name)");

  if (!hasColumn(db, "projects", "root_key")) {
    db.run("ALTER TABLE projects ADD COLUMN root_key TEXT");
  }

  const rows = db
    .query("SELECT id, root_path, created_at FROM projects ORDER BY created_at ASC, id ASC")
    .all() as Array<{ id: string; root_path: string | null; created_at: string }>;

  const update = db.prepare("UPDATE projects SET root_key = ? WHERE id = ?");
  const claimed = new Map<string, string>();

  for (const row of rows) {
    if (!row.root_path) continue;
    const key = normalizeRootPath(row.root_path);
    if (key === "") continue;

    const owner = claimed.get(key);
    if (owner) {
      // Two rows normalize to the same root. Merging them would move tasks
      // between projects without evidence, so the later row stays unlinked and
      // is reported for manual review.
      console.warn(
        `[RequireFlow] Project ${row.id} shares a normalized root with ${owner}; leaving it unlinked.`
      );
      update.run(null, row.id);
      continue;
    }

    claimed.set(key, row.id);
    update.run(key, row.id);
  }

  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root_key ON projects(root_key) WHERE root_key IS NOT NULL"
  );
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema_with_fts5",
    sql: INITIAL_SCHEMA,
  },
  {
    version: 2,
    name: "project_identity_by_root_path",
    run: migrateProjectIdentity,
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
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    db.transaction(() => {
      if (migration.sql) {
        db.run(migration.sql);
      }
      migration.run?.(db);
      db.run(
        "INSERT INTO _schema_migrations (version, name) VALUES (?, ?)",
        [migration.version, migration.name]
      );
    })();
  }
}
