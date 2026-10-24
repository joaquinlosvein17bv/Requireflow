import { Database } from "bun:sqlite";
import crypto from "node:crypto";
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

/**
 * Canonicalizes every stored timestamp to ISO 8601 UTC and records one row per
 * completed work cycle, so reopening a task appends a cycle instead of
 * overwriting the previous duration (RF-09, RF-11).
 */
function migrateCanonicalTimeAndCycles(db: Database): void {
  const tables: Array<{ table: string; columns: string[] }> = [
    { table: "projects", columns: ["created_at", "updated_at"] },
    { table: "sections", columns: ["created_at"] },
    {
      table: "tasks",
      columns: ["created_at", "updated_at", "started_at", "completed_at", "archived_at"],
    },
    { table: "history", columns: ["started_at", "completed_at", "archived_at"] },
  ];

  for (const { table, columns } of tables) {
    for (const column of columns) {
      db.run(
        `UPDATE ${table}
            SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
          WHERE ${column} IS NOT NULL
            AND ${column} NOT LIKE '%T%'`
      );
    }
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS task_cycles (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      cycle_time_seconds INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_task_cycles_project_completed ON task_cycles(project_id, completed_at)"
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_task_cycles_task ON task_cycles(task_id)");

  // Backfill one cycle per already-completed task. Tasks that were never started
  // get a zero-length cycle so their completion still counts for throughput and
  // lead time without inflating average cycle time.
  const completed = db
    .query(
      `SELECT t.id, t.project_id, t.started_at, t.completed_at, t.cycle_time_seconds
         FROM tasks t
        WHERE t.completed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM task_cycles c WHERE c.task_id = t.id)`
    )
    .all() as Array<{
    id: string;
    project_id: string;
    started_at: string | null;
    completed_at: string;
    cycle_time_seconds: number | null;
  }>;

  const insert = db.prepare(`
    INSERT INTO task_cycles (id, task_id, project_id, started_at, completed_at, cycle_time_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const task of completed) {
    const startedAt = task.started_at ?? task.completed_at;
    const cycleSeconds =
      task.cycle_time_seconds ??
      Math.max(0, Math.round((Date.parse(task.completed_at) - Date.parse(startedAt)) / 1000));

    insert.run(
      crypto.randomUUID(),
      task.id,
      task.project_id,
      startedAt,
      task.completed_at,
      cycleSeconds,
      task.completed_at
    );
  }
}

/**
 * One history row per task. Re-archiving used to append a second permanent row
 * for the same task, inflating the changelog (RF-10). Duplicates are collapsed
 * keeping the most recent snapshot.
 */
function migrateHistoryUniqueness(db: Database): void {
  db.run(`
    DELETE FROM history
     WHERE rowid NOT IN (
       SELECT rowid FROM (
         SELECT rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY task_id
                  ORDER BY archived_at DESC, rowid DESC
                ) AS position
           FROM history
       )
       WHERE position = 1
     )
  `);

  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_history_task_unique ON history(task_id)");
}

/**
 * Makes the permanent history genuinely permanent: `task_id` becomes nullable
 * with `ON DELETE SET NULL`, and the section label/colour are snapshotted so
 * deleting a section does not blank the record. History still belongs to its
 * project, so deleting a project removes it (RF-05).
 */
function migrateHistoryPreservation(db: Database): void {
  db.run(`
    CREATE TABLE history_next (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      project_id TEXT NOT NULL,
      section_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      notes TEXT,
      tags TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      archived_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      cycle_time_seconds INTEGER,
      total_cycle_time_ms INTEGER,
      section_name TEXT,
      section_color TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
  `);

  db.run(`
    INSERT INTO history_next (
      id, task_id, project_id, section_id, title, description, type, priority,
      notes, tags, started_at, completed_at, archived_at, cycle_time_seconds,
      total_cycle_time_ms, section_name, section_color
    )
    SELECT h.id, h.task_id, h.project_id, h.section_id, h.title, h.description,
           h.type, h.priority, h.notes, h.tags, h.started_at, h.completed_at,
           h.archived_at, h.cycle_time_seconds, h.total_cycle_time_ms,
           s.name, s.color
      FROM history h
      LEFT JOIN sections s ON s.id = h.section_id;
  `);

  db.run("DROP TABLE history");
  db.run("ALTER TABLE history_next RENAME TO history");

  db.run("CREATE INDEX IF NOT EXISTS idx_history_project_archived ON history(project_id, archived_at)");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_history_task_unique ON history(task_id)");

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_history_ai AFTER INSERT ON history BEGIN
      INSERT INTO history_fts(id, task_id, project_id, title, description, notes)
      VALUES (
        new.id, new.task_id, new.project_id, new.title,
        coalesce(new.description, ''), coalesce(new.notes, '')
      );
    END;
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_history_ad AFTER DELETE ON history BEGIN
      DELETE FROM history_fts WHERE id = old.id;
    END;
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_history_au AFTER UPDATE ON history BEGIN
      DELETE FROM history_fts WHERE id = old.id;
      INSERT INTO history_fts(id, task_id, project_id, title, description, notes)
      VALUES (
        new.id, new.task_id, new.project_id, new.title,
        coalesce(new.description, ''), coalesce(new.notes, '')
      );
    END;
  `);

  // The copy above ran before the triggers existed, so rebuild the index.
  db.run("DELETE FROM history_fts");
  db.run(`
    INSERT INTO history_fts(id, task_id, project_id, title, description, notes)
    SELECT id, coalesce(task_id, ''), project_id, title,
           coalesce(description, ''), coalesce(notes, '')
      FROM history;
  `);
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
  {
    version: 3,
    name: "canonical_time_and_task_cycles",
    run: migrateCanonicalTimeAndCycles,
  },
  {
    version: 4,
    name: "history_one_row_per_task",
    run: migrateHistoryUniqueness,
  },
  {
    version: 5,
    name: "history_preserved_after_task_delete",
    run: migrateHistoryPreservation,
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
