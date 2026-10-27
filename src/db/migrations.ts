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

/**
 * Planning core for RequireFlow 2: project mode, the work-item lattice
 * (idea/epic/story), the append-only change log and idempotency keys.
 *
 * Everything here is additive. `tasks`, `task_cycles` and `history` keep their
 * exact meaning; the only touch is a nullable pointer from a task to the story
 * that authorised it, so execution can be traced without reinterpreting status.
 */
function migratePlanningCore(db: Database): void {
  if (!hasColumn(db, "projects", "mode")) {
    // SQLite cannot add a CHECK constraint without rebuilding the table, so the
    // value is constrained in the domain layer instead.
    db.run("ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'");
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('idea', 'epic', 'story')),
      parent_id TEXT,
      code TEXT,
      title TEXT NOT NULL,
      original_text TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'captured'
        CHECK (status IN ('captured', 'draft', 'refined', 'ready', 'discarded')),
      definition TEXT NOT NULL DEFAULT 'unspecified'
        CHECK (definition IN ('clear', 'partial', 'unspecified', 'deferred', 'delegated')),
      origin TEXT NOT NULL DEFAULT 'user'
        CHECK (origin IN ('user', 'derived', 'agent', 'preexisting')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'blocker')),
      position INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      refined_at TEXT,
      discarded_at TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_id) REFERENCES work_items(id) ON DELETE RESTRICT
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_work_items_project_kind ON work_items(project_id, kind, position)"
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items(parent_id)");
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_code ON work_items(project_id, code) WHERE code IS NOT NULL"
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS change_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      from_value TEXT,
      to_value TEXT,
      payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_change_log_project_created ON change_log(project_id, created_at)"
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log(entity_type, entity_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  if (!hasColumn(db, "tasks", "work_item_id")) {
    db.run("ALTER TABLE tasks ADD COLUMN work_item_id TEXT REFERENCES work_items(id) ON DELETE RESTRICT");
  }
  if (!hasColumn(db, "tasks", "odd_task_ref")) {
    db.run("ALTER TABLE tasks ADD COLUMN odd_task_ref TEXT");
  }
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_odd_ref ON tasks(work_item_id, odd_task_ref) WHERE odd_task_ref IS NOT NULL"
  );
}

/**
 * Groups (increments), membership with history, dependencies, confirmed
 * decisions, stable acceptance criteria, approved scope snapshots and the human
 * review loop.
 *
 * Additive only. `tasks`, `task_cycles` and `history` keep their meaning.
 */
function migrateGroupsAndReviews(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS increments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT,
      goal TEXT,
      status TEXT NOT NULL DEFAULT 'planificado'
        CHECK (status IN ('planificado', 'en_refinamiento', 'listo_para_aprobacion',
                          'aprobado', 'en_implementacion', 'pendiente_revision_humana',
                          'en_correcciones', 'aceptado', 'bloqueado')),
      position INTEGER NOT NULL DEFAULT 0,
      exclusiones TEXT,
      scope_hash TEXT,
      approved_scope_hash TEXT,
      approved_revision INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      approved_by TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_increments_code ON increments(project_id, code)"
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_increments_project_position ON increments(project_id, position)"
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS increment_stories (
      id TEXT PRIMARY KEY,
      increment_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      removed_at TEXT,
      FOREIGN KEY(increment_id) REFERENCES increments(id) ON DELETE CASCADE,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
    );
  `);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_increment_stories_active ON increment_stories(increment_id, work_item_id) WHERE removed_at IS NULL"
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_increment_stories_item ON increment_stories(work_item_id)"
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS increment_dependencies (
      increment_id TEXT NOT NULL,
      depends_on_increment_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (increment_id, depends_on_increment_id),
      FOREIGN KEY(increment_id) REFERENCES increments(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_increment_id) REFERENCES increments(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      increment_id TEXT,
      work_item_id TEXT,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      alternatives TEXT,
      impact TEXT,
      status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('accepted', 'superseded')),
      superseded_by TEXT,
      actor TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(increment_id) REFERENCES increments(id) ON DELETE SET NULL,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
    );
  `);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_code ON decisions(project_id, code)"
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_decisions_increment ON decisions(increment_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS acceptance_criteria (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      increment_id TEXT NOT NULL,
      code TEXT NOT NULL,
      text TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'retired')),
      superseded_by TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(increment_id) REFERENCES increments(id) ON DELETE CASCADE
    );
  `);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_ac_code ON acceptance_criteria(project_id, code)"
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_ac_increment ON acceptance_criteria(increment_id, position)"
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS increment_revisions (
      id TEXT PRIMARY KEY,
      increment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      scope_hash TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(increment_id, revision),
      FOREIGN KEY(increment_id) REFERENCES increments(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS increment_reviews (
      id TEXT PRIMARY KEY,
      increment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'changes_requested', 'accepted')),
      evidence TEXT,
      requested_at TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      notes TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(increment_id, cycle),
      FOREIGN KEY(increment_id) REFERENCES increments(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      acceptance_criterion_id TEXT,
      kind TEXT NOT NULL DEFAULT 'defect' CHECK (kind IN ('defect', 'observation')),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(review_id) REFERENCES increment_reviews(id) ON DELETE CASCADE,
      FOREIGN KEY(acceptance_criterion_id) REFERENCES acceptance_criteria(id) ON DELETE SET NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS review_results (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      acceptance_criterion_id TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
      evidence TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(review_id) REFERENCES increment_reviews(id) ON DELETE CASCADE,
      FOREIGN KEY(acceptance_criterion_id) REFERENCES acceptance_criteria(id) ON DELETE CASCADE
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_review_results_review ON review_results(review_id)"
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
  {
    version: 6,
    name: "planning_core_and_project_mode",
    run: migratePlanningCore,
  },
  {
    version: 7,
    name: "groups_criteria_reviews_and_scope_snapshots",
    run: migrateGroupsAndReviews,
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

  for (const migration of MIGRATIONS) {
    // The check must happen under the write lock: two processes opening the same
    // database for the first time would otherwise both decide the migration is
    // pending and one would fail with a primary key violation.
    db.transaction(() => {
      const applied = db
        .query("SELECT 1 as applied FROM _schema_migrations WHERE version = ?")
        .get(migration.version) as { applied: number } | null;

      if (applied) {
        return;
      }

      if (migration.sql) {
        db.run(migration.sql);
      }
      migration.run?.(db);
      db.run(
        "INSERT INTO _schema_migrations (version, name) VALUES (?, ?)",
        [migration.version, migration.name]
      );
    }).immediate();
  }
}
