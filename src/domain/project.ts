import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";
import { seedDefaultSections } from "./section.ts";
import { normalizeRootPath, isInsideRoot } from "./root-path.ts";
import { nowIso } from "./time.ts";

export { normalizeRootPath } from "./root-path.ts";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  root_path: string | null;
  root_key: string | null;
  archive_threshold_hours: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithStats extends Project {
  active_tasks_count?: number;
  todo_count?: number;
  in_progress_count?: number;
  done_count?: number;
  archived_count?: number;
}

export interface ProjectDetection {
  project: Project | null;
  /** Absolute path the detection used (git root when available). */
  rootPath: string;
  /** Normalized identity of `rootPath`. */
  rootKey: string;
  isLinked: boolean;
  source: "exact" | "nested" | "none";
}

export function findGitRoot(startDir: string = process.cwd()): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

/** Resolves the directory a project identity should be derived from. */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  return findGitRoot(cwd) || path.resolve(cwd);
}

export function getProjectByRootKey(
  rootKey: string,
  db: Database = getDatabase()
): Project | null {
  return db
    .query("SELECT * FROM projects WHERE root_key = ?")
    .get(rootKey) as Project | null;
}

/**
 * Detects the project that owns a directory without creating anything.
 *
 * Exact root matches win. Inside a git repository the git root is the identity,
 * so `src/domain` resolves to its project and a nested checkout never inherits
 * an umbrella project registered on its parent directory. For plain
 * directories, the deepest registered root containing the path is used.
 */
export function detectProject(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): ProjectDetection {
  const gitRoot = findGitRoot(cwd);
  const rootPath = gitRoot || path.resolve(cwd);
  const rootKey = normalizeRootPath(rootPath);

  const exact = getProjectByRootKey(rootKey, db);
  if (exact) {
    return { project: exact, rootPath, rootKey, isLinked: true, source: "exact" };
  }

  // A git root that is not registered is a different project, even if some
  // registered root contains it on disk.
  if (gitRoot) {
    return { project: null, rootPath, rootKey, isLinked: false, source: "none" };
  }

  const candidates = db
    .query("SELECT * FROM projects WHERE root_key IS NOT NULL")
    .all() as Project[];

  let best: Project | null = null;
  let bestLength = -1;
  for (const candidate of candidates) {
    const key = candidate.root_key;
    if (!key || !isInsideRoot(rootKey, key)) continue;
    if (key.length > bestLength) {
      best = candidate;
      bestLength = key.length;
    }
  }

  if (best) {
    return { project: best, rootPath, rootKey, isLinked: true, source: "nested" };
  }

  return { project: null, rootPath, rootKey, isLinked: false, source: "none" };
}

/** Projects whose stored root is missing on disk, a symptom of old name collisions. */
export function findProjectsWithMissingRoots(db: Database = getDatabase()): Project[] {
  const projects = db
    .query("SELECT * FROM projects WHERE root_path IS NOT NULL")
    .all() as Project[];

  return projects.filter((project) => {
    const rootPath = project.root_path;
    return rootPath !== null && !fs.existsSync(rootPath);
  });
}

export function resolveCurrentProject(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): Project {
  const rootPath = resolveProjectRoot(cwd);
  const projectName = path.basename(rootPath) || "default-project";

  return getOrCreateProject(projectName, rootPath, db);
}

/**
 * Finds or creates the project that owns `rootPath`.
 *
 * Identity is the normalized root path, never the name: two repositories whose
 * directory is called `backend` are different projects. A project is adopted by
 * name only when it is the single project with that display name and it has no
 * root yet (rows created from the dashboard without a path).
 */
export function getOrCreateProject(
  name: string,
  rootPath?: string,
  db: Database = getDatabase()
): Project {
  const rootKey = rootPath ? normalizeRootPath(rootPath) : null;

  if (rootKey) {
    const existing = getProjectByRootKey(rootKey, db);
    if (existing) {
      return existing;
    }
  }

  const unlinked = db
    .query("SELECT * FROM projects WHERE name = ? AND root_path IS NULL")
    .all(name) as Project[];

  if (unlinked.length === 1) {
    const candidate = unlinked[0];
    if (candidate === undefined) {
      // Unreachable: guarded by the length check, kept for the type checker.
      throw new Error("Unexpected empty project candidate");
    }

    if (!rootKey) {
      return candidate;
    }

    db.run(
      "UPDATE projects SET root_path = ?, root_key = ?, updated_at = ? WHERE id = ?",
      [rootPath ?? null, rootKey, nowIso(), candidate.id]
    );
    return db.query("SELECT * FROM projects WHERE id = ?").get(candidate.id) as Project;
  }

  const id = crypto.randomUUID();
  const timestamp = nowIso();
  db.run(
    `INSERT INTO projects (id, name, description, root_path, root_key, archive_threshold_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, `Project for ${name}`, rootPath || null, rootKey, 24, timestamp, timestamp]
  );

  seedDefaultSections(id, db);

  return db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project;
}

export function createProject(
  data: {
    name: string;
    description?: string;
    rootPath?: string;
    archiveThresholdHours?: number;
  },
  db: Database = getDatabase()
): Project {
  const id = crypto.randomUUID();
  const rootPath = data.rootPath || null;
  const rootKey = rootPath ? normalizeRootPath(rootPath) : null;
  const timestamp = nowIso();

  db.run(
    `INSERT INTO projects (id, name, description, root_path, root_key, archive_threshold_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.description || null,
      rootPath,
      rootKey,
      data.archiveThresholdHours ?? 24,
      timestamp,
      timestamp,
    ]
  );

  seedDefaultSections(id, db);
  return db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project;
}

export function getProject(
  id: string,
  db: Database = getDatabase()
): Project | null {
  return db.query("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
}

export function listProjects(db: Database = getDatabase()): ProjectWithStats[] {
  const projects = db.query("SELECT * FROM projects ORDER BY name ASC").all() as Project[];

  return projects.map((p) => {
    const stats = db
      .query(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo_count,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_count,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_count,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived_count,
          SUM(CASE WHEN status IN ('backlog', 'todo', 'in_progress', 'done') THEN 1 ELSE 0 END) as active_count
        FROM tasks 
        WHERE project_id = ?
      `)
      .get(p.id) as any;

    return {
      ...p,
      active_tasks_count: Number(stats?.active_count || 0),
      todo_count: Number(stats?.todo_count || 0),
      in_progress_count: Number(stats?.in_progress_count || 0),
      done_count: Number(stats?.done_count || 0),
      archived_count: Number(stats?.archived_count || 0),
    };
  });
}

export function updateProject(
  id: string,
  updates: Partial<Pick<Project, "name" | "description" | "root_path" | "archive_threshold_hours" | "root_key">>,
  db: Database = getDatabase()
): Project | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description);
  }
  if (updates.root_path !== undefined) {
    fields.push("root_path = ?");
    values.push(updates.root_path);
    fields.push("root_key = ?");
    values.push(updates.root_path ? normalizeRootPath(updates.root_path) : null);
  }
  if (updates.archive_threshold_hours !== undefined) {
    fields.push("archive_threshold_hours = ?");
    values.push(updates.archive_threshold_hours);
  }

  if (fields.length === 0) {
    return getProject(id, db);
  }

  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(id);

  db.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, values);
  return getProject(id, db);
}

export function deleteProject(id: string, db: Database = getDatabase()): boolean {
  const result = db.run("DELETE FROM projects WHERE id = ?", [id]);
  return result.changes > 0;
}
