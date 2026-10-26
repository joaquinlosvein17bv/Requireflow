import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectDatabase } from "../../db/connection.ts";

/**
 * One-way archival export of a RequireFlow 1 database.
 *
 * The legacy database is never migrated, never written to, and never imported
 * automatically. A consistent snapshot is taken with `VACUUM INTO` from a
 * read-only connection (the live file uses WAL, so copying the .db alone would
 * lose committed rows), then every row is rendered to Markdown plus a
 * structured JSON backup that can be verified against the snapshot.
 */

interface ColumnSet {
  [table: string]: Set<string>;
}

export interface LegacyExportOptions {
  sourcePath: string;
  outDir: string;
  force?: boolean;
  now?: Date;
}

export interface LegacyExportCounts {
  projects: number;
  sections: number;
  tasks: number;
  history: number;
  config: number;
}

export interface LegacyExportResult {
  outDir: string;
  indexPath: string;
  jsonPath: string;
  projectFiles: string[];
  schemaVersion: number;
  sourcePath: string;
  snapshotSha256: string;
  contentSha256: string;
  counts: LegacyExportCounts;
  verified: boolean;
  integrity: string;
}

interface SectionRow {
  id: string;
  name: string;
  color: string | null;
  position: number | null;
  created_at: string | null;
}

interface TaskRow {
  id: string;
  section_id: string | null;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  position: number | null;
  story_points: number | null;
  tags: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  cycle_time_seconds: number | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface HistoryRow {
  id: string;
  task_id: string | null;
  section_id: string | null;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  notes: string | null;
  tags: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  cycle_time_seconds: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  root_path: string | null;
  archive_threshold_hours: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ProjectExport extends ProjectRow {
  sections: SectionRow[];
  tasks: TaskRow[];
  history: HistoryRow[];
  notRecorded: string[];
}

interface LegacyModel {
  schemaVersion: number;
  exportedAt: string;
  integrity: string;
  notRecorded: string[];
  counts: LegacyExportCounts;
  projects: ProjectExport[];
}

const NOT_RECORDED_LABEL = "— (no registrado en el esquema v1)";

function readColumns(db: Database, tables: string[]): ColumnSet {
  const result: ColumnSet = {};
  for (const table of tables) {
    try {
      const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      result[table] = new Set(rows.map((row) => row.name));
    } catch {
      result[table] = new Set();
    }
  }
  return result;
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | null;
  return row !== null;
}

/** Reads every representable field, marking the ones the schema never had. */
function pick(
  row: Record<string, unknown>,
  column: string,
  columns: Set<string>,
  notRecorded: Set<string>
): any {
  if (!columns.has(column)) {
    notRecorded.add(column);
    return null;
  }
  const value = row[column];
  return value === undefined ? null : value;
}

export function takeSnapshot(sourcePath: string, targetPath: string): void {
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Legacy database not found: ${resolved}`);
  }

  const db = new Database(resolved, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const integrity = db.query("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (integrity[0]?.integrity_check !== "ok") {
      throw new Error(
        `Legacy database failed integrity_check: ${JSON.stringify(integrity)}`
      );
    }
    db.run(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readModel(db: Database, exportedAt: string): LegacyModel {
  if (!tableExists(db, "projects") || !tableExists(db, "tasks")) {
    throw new Error(
      "This file does not look like a RequireFlow legacy database: the projects or tasks table is missing."
    );
  }

  const tables = ["projects", "sections", "tasks", "history", "config"].filter((table) =>
    tableExists(db, table)
  );
  const columns = readColumns(db, tables);
  const notRecorded = new Set<string>();

  // Fields that only exist from v2 onwards are named explicitly instead of
  // being guessed or silently omitted.
  const v2OnlyFields: Array<[string, string]> = [
    ["projects", "root_key"],
    ["projects", "mode"],
    ["tasks", "work_item_id"],
    ["tasks", "odd_task_ref"],
    ["history", "section_name"],
    ["history", "section_color"],
    ["history", "total_cycle_time_ms"],
  ];
  for (const [table, column] of v2OnlyFields) {
    if (columns[table] && !columns[table]!.has(column)) {
      notRecorded.add(`${table}.${column}`);
    }
  }

  const integrityRows = db.query("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;

  const projects = db
    .query("SELECT * FROM projects ORDER BY name ASC, id ASC")
    .all() as Array<Record<string, unknown>>;

  const projectExports: ProjectExport[] = projects.map((raw) => {
    const projectNotRecorded = new Set<string>();
    const id = String(raw.id);

    const project: ProjectRow = {
      id,
      name: String(raw.name),
      description: pick(raw, "description", columns.projects!, notRecorded),
      root_path: pick(raw, "root_path", columns.projects!, notRecorded),
      archive_threshold_hours: pick(
        raw,
        "archive_threshold_hours",
        columns.projects!,
        notRecorded
      ),
      created_at: pick(raw, "created_at", columns.projects!, notRecorded),
      updated_at: pick(raw, "updated_at", columns.projects!, notRecorded),
    };

    const sections = (
      db
        .query(
          "SELECT * FROM sections WHERE project_id = ? ORDER BY position ASC, created_at ASC, id ASC"
        )
        .all(id) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      color: pick(row, "color", columns.sections ?? new Set(), notRecorded),
      position: pick(row, "position", columns.sections ?? new Set(), notRecorded),
      created_at: pick(row, "created_at", columns.sections ?? new Set(), notRecorded),
    }));

    const tasks = (
      db
        .query(
          "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC"
        )
        .all(id) as Array<Record<string, unknown>>
    ).map((row) => {
      const taskColumns = columns.tasks ?? new Set<string>();
      return {
        id: String(row.id),
        section_id: pick(row, "section_id", taskColumns, notRecorded),
        title: String(row.title),
        description: pick(row, "description", taskColumns, notRecorded),
        type: String(row.type),
        priority: String(row.priority),
        status: String(row.status),
        position: pick(row, "position", taskColumns, notRecorded),
        story_points: pick(row, "story_points", taskColumns, notRecorded),
        tags: pick(row, "tags", taskColumns, notRecorded),
        started_at: pick(row, "started_at", taskColumns, notRecorded),
        completed_at: pick(row, "completed_at", taskColumns, notRecorded),
        archived_at: pick(row, "archived_at", taskColumns, notRecorded),
        cycle_time_seconds: pick(
          row,
          "cycle_time_seconds",
          taskColumns,
          notRecorded
        ),
        notes: pick(row, "notes", taskColumns, notRecorded),
        created_at: pick(row, "created_at", taskColumns, notRecorded),
        updated_at: pick(row, "updated_at", taskColumns, notRecorded),
      } satisfies TaskRow;
    });

    const history = tableExists(db, "history")
      ? (
          db
            .query(
              "SELECT * FROM history WHERE project_id = ? ORDER BY archived_at ASC, id ASC"
            )
            .all(id) as Array<Record<string, unknown>>
        ).map((row) => {
          const historyColumns = columns.history ?? new Set<string>();
          return {
            id: String(row.id),
            task_id: pick(row, "task_id", historyColumns, notRecorded),
            section_id: pick(row, "section_id", historyColumns, notRecorded),
            title: String(row.title),
            description: pick(row, "description", historyColumns, notRecorded),
            type: String(row.type),
            priority: String(row.priority),
            notes: pick(row, "notes", historyColumns, notRecorded),
            tags: pick(row, "tags", historyColumns, notRecorded),
            started_at: pick(row, "started_at", historyColumns, notRecorded),
            completed_at: pick(row, "completed_at", historyColumns, notRecorded),
            archived_at: pick(row, "archived_at", historyColumns, notRecorded),
            cycle_time_seconds: pick(
              row,
              "cycle_time_seconds",
              historyColumns,
              notRecorded
            ),
          } satisfies HistoryRow;
        })
      : [];

    return {
      ...project,
      sections,
      tasks,
      history,
      notRecorded: [...projectNotRecorded].sort(),
    };
  });

  const count = (table: string): number => {
    if (!tableExists(db, table)) return 0;
    const row = db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
    return Number(row.c);
  };

  const schemaVersionRow = tableExists(db, "_schema_migrations")
    ? (db.query("SELECT COALESCE(MAX(version), 0) v FROM _schema_migrations").get() as {
        v: number;
      })
    : { v: 0 };

  return {
    schemaVersion: Number(schemaVersionRow.v),
    exportedAt,
    integrity: integrityRows[0]?.integrity_check ?? "unknown",
    notRecorded: [...notRecorded].sort(),
    counts: {
      projects: count("projects"),
      sections: count("sections"),
      tasks: count("tasks"),
      history: count("history"),
      config: count("config"),
    },
    projects: projectExports,
  };
}

function escapeCell(value: unknown): string {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function slugify(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized === "" ? "project" : normalized.slice(0, 60);
}

function renderProject(project: ProjectExport): string {
  const lines: string[] = [];
  lines.push(`## ${project.name}`);
  lines.push("");
  lines.push(`- **ID:** \`${project.id}\``);
  lines.push(`- **Root path:** ${project.root_path ?? "—"}`);
  lines.push(`- **Description:** ${project.description ?? "—"}`);
  lines.push(
    `- **Archive threshold (hours):** ${project.archive_threshold_hours ?? NOT_RECORDED_LABEL}`
  );
  lines.push(`- **Created:** ${project.created_at ?? "—"}`);
  lines.push(`- **Updated:** ${project.updated_at ?? "—"}`);
  lines.push(`- **Sections:** ${project.sections.length}`);
  lines.push(`- **Tasks:** ${project.tasks.length}`);
  lines.push(`- **History rows:** ${project.history.length}`);
  lines.push("");

  lines.push("### Sections");
  lines.push("");
  if (project.sections.length === 0) {
    lines.push("_No sections._");
  } else {
    for (const section of project.sections) {
      lines.push(
        `- \`${section.id}\` — **${section.name}** · color ${section.color ?? "—"} · position ${section.position ?? "—"}`
      );
    }
  }
  lines.push("");

  lines.push("### Tasks");
  lines.push("");
  if (project.tasks.length === 0) {
    lines.push("_No tasks._");
  } else {
    const sectionName = new Map(project.sections.map((section) => [section.id, section.name]));
    for (const task of project.tasks) {
      const section = task.section_id ? sectionName.get(task.section_id) ?? task.section_id : "—";
      lines.push(`#### [${task.status}] ${task.title}`);
      lines.push("");
      lines.push(`- **ID:** \`${task.id}\``);
      lines.push(`- **Type / priority:** ${task.type} / ${task.priority}`);
      lines.push(`- **Section:** ${section}`);
      lines.push(`- **Position:** ${task.position ?? "—"}`);
      lines.push(
        `- **Story points:** ${task.story_points ?? NOT_RECORDED_LABEL}`
      );
      lines.push(`- **Tags:** ${task.tags ?? "—"}`);
      lines.push(`- **Started:** ${task.started_at ?? "—"}`);
      lines.push(`- **Completed:** ${task.completed_at ?? "—"}`);
      lines.push(`- **Archived:** ${task.archived_at ?? "—"}`);
      lines.push(
        `- **Cycle time (s):** ${task.cycle_time_seconds ?? NOT_RECORDED_LABEL}`
      );
      lines.push(`- **Created:** ${task.created_at ?? "—"}`);
      lines.push(`- **Updated:** ${task.updated_at ?? "—"}`);
      lines.push("");
      lines.push("**Description**");
      lines.push("");
      lines.push(task.description ?? "_No description._");
      lines.push("");
      lines.push("**Resolution notes**");
      lines.push("");
      lines.push(task.notes ?? "_No notes._");
      lines.push("");
    }
  }

  lines.push("### History");
  lines.push("");
  if (project.history.length === 0) {
    lines.push("_No history rows._");
  } else {
    for (const entry of project.history) {
      lines.push(`#### ${entry.title}`);
      lines.push("");
      lines.push(`- **ID:** \`${entry.id}\``);
      lines.push(`- **Task ID:** ${entry.task_id ? `\`${entry.task_id}\`` : "—"}`);
      lines.push(`- **Type / priority:** ${entry.type} / ${entry.priority}`);
      lines.push(`- **Archived:** ${entry.archived_at ?? "—"}`);
      lines.push(`- **Started / completed:** ${entry.started_at ?? "—"} → ${entry.completed_at ?? "—"}`);
      lines.push(
        `- **Cycle time (s):** ${entry.cycle_time_seconds ?? NOT_RECORDED_LABEL}`
      );
      lines.push(`- **Tags:** ${entry.tags ?? "—"}`);
      lines.push("");
      lines.push("**Description**");
      lines.push("");
      lines.push(entry.description ?? "_No description._");
      lines.push("");
      lines.push("**Resolution notes**");
      lines.push("");
      lines.push(entry.notes ?? "_No notes._");
      lines.push("");
    }
  }

  if (project.notRecorded.length > 0) {
    lines.push(
      `_Fields absent from this schema version: ${project.notRecorded.join(", ")}._`
    );
    lines.push("");
  }

  return lines.join("\n");
}

function renderIndex(model: LegacyModel, sourcePath: string, snapshotSha256: string): string {
  const lines: string[] = [];
  lines.push("# RequireFlow — Legacy database export");
  lines.push("");
  lines.push(
    "> Archival snapshot of a RequireFlow 1 database. This file is **not** the RequireFlow 2 backlog:"
  );
  lines.push(
    "> it is a read-only record, generated from a consistent SQLite snapshot. Nothing was migrated,"
  );
  lines.push("> imported or modified.");
  lines.push("");
  lines.push("## Export metadata");
  lines.push("");
  lines.push(`- **Source database:** \`${sourcePath}\``);
  lines.push(`- **Detected schema version:** v${model.schemaVersion} (RequireFlow 1)`);
  lines.push(`- **Exported at:** ${model.exportedAt}`);
  lines.push("- **Method:** `VACUUM INTO` on a read-only connection (WAL-safe snapshot)");
  lines.push(`- **Snapshot SHA-256:** \`${snapshotSha256}\``);
  lines.push(`- **Source integrity check:** ${model.integrity}`);
  lines.push(
    `- **Counts:** ${model.counts.projects} projects · ${model.counts.sections} sections · ${model.counts.tasks} tasks · ${model.counts.history} history rows`
  );
  lines.push("");
  lines.push("### Fields not recorded in this schema version");
  lines.push("");
  if (model.notRecorded.length === 0) {
    lines.push("_None: every field read by the exporter exists in this schema._");
  } else {
    for (const field of model.notRecorded) {
      lines.push(`- \`${field}\``);
    }
    lines.push("");
    lines.push(
      "These values are marked in the per-project files instead of being invented."
    );
  }
  lines.push("");
  lines.push("## Index");
  lines.push("");
  lines.push("| Project | Root path | Sections | Tasks | History |");
  lines.push("| :-- | :-- | --: | --: | --: |");
  for (const project of model.projects) {
    lines.push(
      `| ${escapeCell(project.name)} | ${escapeCell(project.root_path)} | ${project.sections.length} | ${project.tasks.length} | ${project.history.length} |`
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const project of model.projects) {
    lines.push(renderProject(project));
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

export function exportLegacyDatabase(options: LegacyExportOptions): LegacyExportResult {
  const sourcePath = path.resolve(options.sourcePath);
  const outDir = path.resolve(options.outDir);
  const exportedAt = (options.now ?? new Date()).toISOString();

  const inspection = inspectDatabase(sourcePath);
  if (!inspection.exists) {
    throw new Error(`Legacy database not found: ${sourcePath}`);
  }

  const indexPath = path.join(outDir, "requireflow-legacy-export.md");
  const jsonPath = path.join(outDir, "requireflow-legacy-export.json");
  const projectsDir = path.join(outDir, "projects");

  if (!options.force && (fs.existsSync(indexPath) || fs.existsSync(jsonPath))) {
    throw new Error(
      `Export already exists in ${outDir}. Re-run with --force to overwrite the generated files.`
    );
  }

  fs.mkdirSync(projectsDir, { recursive: true });

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-legacy-snapshot-"));
  const snapshotPath = path.join(scratchDir, "snapshot.db");

  try {
    takeSnapshot(sourcePath, snapshotPath);
    const snapshotSha256 = sha256File(snapshotPath);

    const db = new Database(snapshotPath, { readonly: true });
    let model: LegacyModel;
    try {
      db.run("PRAGMA busy_timeout = 5000");
      model = readModel(db, exportedAt);
    } finally {
      db.close();
    }

    const json = JSON.stringify(model, null, 2);
    fs.writeFileSync(jsonPath, `${json}\n`, "utf8");
    fs.writeFileSync(indexPath, `${renderIndex(model, sourcePath, snapshotSha256)}\n`, "utf8");

    const projectFiles: string[] = [];
    for (const project of model.projects) {
      const filename = `${slugify(project.name)}-${project.id.slice(0, 8)}.md`;
      const filePath = path.join(projectsDir, filename);
      fs.writeFileSync(filePath, `${renderProject(project)}\n`, "utf8");
      projectFiles.push(filePath);
    }

    // Verification: the written backup must describe exactly the snapshot rows.
    const verifyDb = new Database(snapshotPath, { readonly: true });
    let verified = true;
    try {
      const actual = {
        projects: Number(
          (verifyDb.query("SELECT COUNT(*) c FROM projects").get() as { c: number }).c
        ),
        sections: tableExists(verifyDb, "sections")
          ? Number((verifyDb.query("SELECT COUNT(*) c FROM sections").get() as { c: number }).c)
          : 0,
        tasks: Number(
          (verifyDb.query("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c
        ),
        history: tableExists(verifyDb, "history")
          ? Number((verifyDb.query("SELECT COUNT(*) c FROM history").get() as { c: number }).c)
          : 0,
      };

      verified =
        actual.projects === model.counts.projects &&
        actual.sections === model.counts.sections &&
        actual.tasks === model.counts.tasks &&
        actual.history === model.counts.history;

      const written = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as LegacyModel;
      const writtenCounts = {
        projects: written.counts.projects,
        sections: written.projects.reduce((sum, project) => sum + project.sections.length, 0),
        tasks: written.projects.reduce((sum, project) => sum + project.tasks.length, 0),
        history: written.projects.reduce((sum, project) => sum + project.history.length, 0),
      };
      verified =
        verified &&
        writtenCounts.projects === actual.projects &&
        writtenCounts.sections === actual.sections &&
        writtenCounts.tasks === actual.tasks &&
        writtenCounts.history === actual.history;

      // Every id in the snapshot must be present in the written backup.
      const snapshotIds = new Set<string>();
      for (const table of ["projects", "sections", "tasks", "history"]) {
        if (!tableExists(verifyDb, table)) continue;
        const rows = verifyDb.query(`SELECT id FROM ${table}`).all() as Array<{ id: string }>;
        for (const row of rows) snapshotIds.add(`${table}:${row.id}`);
      }
      const writtenIds = new Set<string>();
      for (const project of written.projects) {
        writtenIds.add(`projects:${project.id}`);
        for (const section of project.sections) writtenIds.add(`sections:${section.id}`);
        for (const task of project.tasks) writtenIds.add(`tasks:${task.id}`);
        for (const entry of project.history) writtenIds.add(`history:${entry.id}`);
      }
      for (const id of snapshotIds) {
        if (!writtenIds.has(id)) verified = false;
      }
    } finally {
      verifyDb.close();
    }

    return {
      outDir,
      indexPath,
      jsonPath,
      projectFiles,
      schemaVersion: model.schemaVersion,
      sourcePath,
      snapshotSha256,
      contentSha256: crypto.createHash("sha256").update(json).digest("hex"),
      counts: model.counts,
      verified,
      integrity: model.integrity,
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
