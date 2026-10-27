import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";
import { seedDefaultSections } from "./section.ts";
import { normalizeRootPath, isInsideRoot } from "./root-path.ts";
import { nowIso } from "./time.ts";
import { appendChange, LOCAL_ACTOR } from "./changelog.ts";

export { normalizeRootPath } from "./root-path.ts";

/**
 * `legacy` keeps the task-only workflow exactly as it is today.
 * `product` enables the planning layer and the approval gate.
 *
 * The column has no SQLite CHECK because the table is not rebuilt; the values
 * are validated here, in one place, for every transport.
 */
export type ProjectMode = "legacy" | "product";
export const PROJECT_MODES: ProjectMode[] = ["legacy", "product"];

export function isProjectMode(value: unknown): value is ProjectMode {
  return typeof value === "string" && PROJECT_MODES.includes(value as ProjectMode);
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  root_path: string | null;
  root_key: string | null;
  archive_threshold_hours: number;
  mode: ProjectMode;
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
  return meaningfulGitRoot(cwd) || path.resolve(cwd);
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
 * Every key form a directory can legitimately be matched by.
 *
 * The resolved path keeps the spelling the caller used; the real path collapses
 * Windows short names (`PROGRA~1`) and junctions, so the same directory never
 * looks like two different projects.
 */
export function canonicalRootKeys(input: string): string[] {
  const keys: string[] = [];
  const resolved = normalizeRootPath(input);
  if (resolved) {
    keys.push(resolved);
  }
  try {
    const realKey = normalizeRootPath(fs.realpathSync.native(path.resolve(input)));
    if (realKey && !keys.includes(realKey)) {
      keys.push(realKey);
    }
  } catch {
    // A missing path can only be matched by its resolved spelling.
  }
  return keys;
}

/**
 * Detects the project that owns a directory without creating anything.
 *
 * 1. An exact root match on the directory itself always wins, so a project
 *    registered at a plain folder is found even when an ancestor happens to be
 *    a git repository.
 * 2. Otherwise the deepest registered root containing the directory is used,
 *    but never across a git boundary: a nested checkout is its own project and
 *    must not be claimed by an umbrella project registered on its parent.
 * 3. A git root that is itself registered still wins when nothing deeper does,
 *    which is the legitimate "subdirectory of a registered repository" case.
 */
export function detectProject(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): ProjectDetection {
  const cwdPath = path.resolve(cwd);
  const cwdKeys = canonicalRootKeys(cwdPath);
  const gitRoot = meaningfulGitRoot(cwdPath);
  const gitKeys = gitRoot ? canonicalRootKeys(gitRoot) : [];

  for (const key of cwdKeys) {
    const exact = getProjectByRootKey(key, db);
    if (exact) {
      return { project: exact, rootPath: cwdPath, rootKey: key, isLinked: true, source: "exact" };
    }
  }

  const candidates = db
    .query("SELECT * FROM projects WHERE root_key IS NOT NULL")
    .all() as Project[];

  let best: Project | null = null;
  let bestLength = -1;
  for (const candidate of candidates) {
    const key = candidate.root_key;
    if (!key) continue;

    const matched = cwdKeys.find((cwdKey) => isInsideRoot(cwdKey, key));
    if (!matched) continue;

    // A git repository between the candidate root and the directory means the
    // directory belongs to that repository, not to the umbrella above it.
    if (gitKeys.some((gitKey) => gitKey !== key && isInsideRoot(gitKey, key))) continue;

    if (key.length > bestLength) {
      best = candidate;
      bestLength = key.length;
    }
  }

  if (best) {
    return {
      project: best,
      rootPath: cwdPath,
      rootKey: cwdKeys[0] ?? normalizeRootPath(cwdPath),
      isLinked: true,
      source: "nested",
    };
  }

  return {
    project: null,
    rootPath: cwdPath,
    rootKey: cwdKeys[0] ?? normalizeRootPath(cwdPath),
    isLinked: false,
    source: "none",
  };
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

/**
 * Resolves the project for a command that may legitimately start new work.
 *
 * Detection runs first, so an already registered project is never duplicated.
 * The implicit registration that follows targets the directory the caller is
 * actually in — never an ancestor git root, which is what manufactured phantom
 * umbrella projects.
 */
export function resolveCurrentProject(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): Project {
  const detection = detectProject(cwd, db);
  if (detection.project) {
    return detection.project;
  }

  const rootPath = path.resolve(cwd);
  const projectName = path.basename(rootPath) || "default-project";
  return getOrCreateProject(projectName, rootPath, db);
}

/**
 * Resolves the project for a read or lifecycle command.
 *
 * Read paths must never mutate the project table: an unregistered directory is
 * an error asking the user to choose, not an invitation to create a project.
 */
export function resolveRegisteredProject(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): Project {
  const detection = detectProject(cwd, db);
  if (detection.project) {
    return detection.project;
  }

  const cwdPath = path.resolve(cwd);
  throw new Error(
    `No project is registered for "${cwdPath}". ` +
      `Run "requireflow init" in that folder, or run the command from a registered project. ` +
      `Use rf_project_list (MCP) or the dashboard to see the registered roots.`
  );
}

export interface InitializeProjectInput {
  cwd: string;
  /** Optional directory explicitly selected by the user (CLI `--root`). */
  explicitRoot?: string;
  mode?: ProjectMode;
  actor?: string;
}

export interface InitializeProjectResult {
  project: Project;
  situation: WorkspaceSituation;
  created: boolean;
}

/**
 * Initializes a project at the directory the user actually selected.
 *
 * `resolveCurrentProject` follows the ancestor Git root, which is correct for
 * implicit reads but wrong for `init`: an empty folder under an umbrella
 * repository must become its own project (RF-V2-01). Ambiguous cases ask for an
 * explicit root instead of creating a phantom project.
 */
export function initializeProject(
  input: InitializeProjectInput,
  db: Database = getDatabase()
): InitializeProjectResult {
  const cwdPath = path.resolve(input.cwd);
  const explicit = input.explicitRoot?.trim();
  const explicitRoot = explicit ? path.resolve(cwdPath, explicit) : null;

  if (
    explicitRoot &&
    (!fs.existsSync(explicitRoot) || !fs.statSync(explicitRoot).isDirectory())
  ) {
    throw new Error(`Cannot initialize "${explicitRoot}": it is not an existing directory.`);
  }

  let classification = classifyWorkspace(cwdPath, db);
  let targetRoot: string;

  if (explicitRoot) {
    classification = classifyWorkspace(explicitRoot, db);
    if (classification.situation === "ambiguous") {
      throw new Error(
        `Refusing to initialize a project in a generic location. ${classification.reason}`
      );
    }
    if (classification.project) {
      if (classification.detectionSource === "exact") {
        return finalizeInitialization(
          classification.project,
          classification.situation,
          false,
          input,
          db
        );
      }
      throw new Error(
        `"${explicitRoot}" already belongs to project "${classification.project.name}" ` +
          `(${classification.project.root_path}). Run init at that project root instead.`
      );
    }
    targetRoot = explicitRoot;
  } else {
    if (classification.project) {
      return finalizeInitialization(
        classification.project,
        classification.situation,
        false,
        input,
        db
      );
    }

    switch (classification.situation) {
      case "empty-new":
        targetRoot = cwdPath;
        break;
      case "nested-independent-repo":
        targetRoot = classification.gitRoot ?? cwdPath;
        break;
      case "existing-unregistered":
        if (
          classification.gitRoot &&
          normalizeRootPath(classification.gitRoot) !== normalizeRootPath(cwdPath)
        ) {
          throw new Error(
            `"${cwdPath}" is inside the git repository "${classification.gitRoot}" but is not its root. ` +
              `Run init with --root . to create an independent project for this folder, or run it from the repository root.`
          );
        }
        targetRoot = cwdPath;
        break;
      default:
        throw new Error(`Refusing to initialize a project here. ${classification.reason}`);
    }
  }

  const rootKey = normalizeRootPath(targetRoot);
  const existing = getProjectByRootKey(rootKey, db);
  const project =
    existing ??
    getOrCreateProject(
      path.basename(targetRoot) || "default-project",
      targetRoot,
      db,
      input.mode ?? "legacy"
    );

  if (project.root_key !== rootKey) {
    throw new Error(
      `Project initialization resolved the wrong root: requested "${targetRoot}", ` +
        `registered "${project.root_path ?? "none"}".`
    );
  }

  return finalizeInitialization(project, classification.situation, existing === null, input, db);
}

function finalizeInitialization(
  project: Project,
  situation: WorkspaceSituation,
  created: boolean,
  input: InitializeProjectInput,
  db: Database
): InitializeProjectResult {
  let resolved = project;
  if (input.mode && resolved.mode !== input.mode) {
    const updated = setProjectMode(resolved.id, input.mode, input.actor ?? "user:cli", db);
    if (updated) resolved = updated;
  }
  return { project: resolved, situation, created };
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
  db: Database = getDatabase(),
  mode: ProjectMode = "legacy"
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
    `INSERT INTO projects (id, name, description, root_path, root_key, archive_threshold_hours, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, `Project for ${name}`, rootPath || null, rootKey, 24, mode, timestamp, timestamp]
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
    mode?: ProjectMode;
  },
  db: Database = getDatabase()
): Project {
  if (data.mode !== undefined && !isProjectMode(data.mode)) {
    throw new Error(
      `Invalid project mode "${String(data.mode)}". Allowed: ${PROJECT_MODES.join(", ")}.`
    );
  }

  const id = crypto.randomUUID();
  const rootPath = data.rootPath || null;
  const rootKey = rootPath ? normalizeRootPath(rootPath) : null;
  const timestamp = nowIso();

  db.run(
    `INSERT INTO projects (id, name, description, root_path, root_key, archive_threshold_hours, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.description || null,
      rootPath,
      rootKey,
      data.archiveThresholdHours ?? 24,
      data.mode ?? "legacy",
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
  updates: Partial<
    Pick<
      Project,
      "name" | "description" | "root_path" | "archive_threshold_hours" | "root_key" | "mode"
    >
  >,
  db: Database = getDatabase()
): Project | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.mode !== undefined && !isProjectMode(updates.mode)) {
    throw new Error(
      `Invalid project mode "${String(updates.mode)}". Allowed: ${PROJECT_MODES.join(", ")}.`
    );
  }

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
  if (updates.mode !== undefined) {
    fields.push("mode = ?");
    values.push(updates.mode);
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

/** Switches a project between the legacy task workflow and the product backlog. */
export function setProjectMode(
  id: string,
  mode: ProjectMode,
  actor: string = LOCAL_ACTOR,
  db: Database = getDatabase()
): Project | null {
  if (!isProjectMode(mode)) {
    throw new Error(`Invalid project mode "${String(mode)}". Allowed: ${PROJECT_MODES.join(", ")}.`);
  }

  const current = getProject(id, db);
  if (!current) return null;
  if (current.mode === mode) return current;

  const updated = updateProject(id, { mode }, db);
  if (updated) {
    appendChange(
      {
        projectId: id,
        entityType: "project",
        entityId: id,
        action: "project.mode_changed",
        actor,
        from: current.mode,
        to: mode,
      },
      db
    );
  }
  return updated;
}

export function deleteProject(id: string, db: Database = getDatabase()): boolean {
  const result = db.run("DELETE FROM projects WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Where a directory sits relative to the registered projects.
 *
 * The distinction that matters is between "nobody registered this yet" and
 * "there is nothing here yet". Treating an unregistered repository as empty is
 * how phantom projects get created; treating a generic directory as an empty
 * product is how one backlog ends up owning the whole home folder.
 */
export type WorkspaceSituation =
  | "project-linked"
  | "project-subfolder"
  | "nested-independent-repo"
  | "empty-new"
  | "existing-unregistered"
  | "ambiguous";

export interface WorkspaceClassification {
  situation: WorkspaceSituation;
  cwd: string;
  rootPath: string;
  rootKey: string;
  project: Project | null;
  detectionSource: "exact" | "nested" | "none";
  gitRoot: string | null;
  isGitRepository: boolean;
  suggestedName: string;
  reason: string;
  /** Only a genuinely empty directory may be initialised without a question. */
  canInitialize: boolean;
  requiresConfirmation: boolean;
}

function isEmptyDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Canonical form used only to compare a path with the generic locations.
 *
 * Windows may hand back an 8.3 short name (`C:\Users\MELIOD~1`) while
 * `os.homedir()` returns the long form. Comparing the raw strings would miss
 * the home directory and turn a dotfiles repository into a product root.
 */
function comparablePath(value: string): string {
  try {
    return normalizeRootPath(fs.realpathSync.native(value));
  } catch {
    return normalizeRootPath(value);
  }
}

/**
 * Generic locations are never a product root on their own: the user works from
 * them, they are not the thing being built.
 */
function isAmbiguousLocation(resolved: string): boolean {
  const key = comparablePath(resolved);
  const home = comparablePath(os.homedir());
  if (key === home) return true;

  const knownFolders = ["Desktop", "Documents", "Downloads", "OneDrive"].map((folder) =>
    comparablePath(path.join(os.homedir(), folder))
  );
  if (knownFolders.includes(key)) return true;

  if (path.parse(resolved).root === resolved) return true;
  if (key === comparablePath(os.tmpdir())) return true;

  return false;
}

/**
 * A git root only defines a boundary when it could plausibly be a product.
 *
 * A dotfiles repository at the home directory is a git root for every path
 * underneath it, so honouring it blindly would bind every folder in the user's
 * home to a single project and manufacture phantom projects.
 */
function meaningfulGitRoot(startDir: string): string | null {
  const root = findGitRoot(startDir);
  if (!root) return null;
  return isAmbiguousLocation(root) ? null : root;
}

function findRegisteredAncestor(cwdKey: string, db: Database): Project | null {
  const candidates = db
    .query("SELECT * FROM projects WHERE root_key IS NOT NULL")
    .all() as Project[];

  let best: Project | null = null;
  let bestLength = -1;
  for (const candidate of candidates) {
    const key = candidate.root_key;
    if (!key) continue;
    if (key === cwdKey) continue;
    if (!isInsideRoot(cwdKey, key)) continue;
    if (key.length > bestLength) {
      best = candidate;
      bestLength = key.length;
    }
  }
  return best;
}

export function classifyWorkspace(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): WorkspaceClassification {
  const cwdPath = path.resolve(cwd);
  const detection = detectProject(cwdPath, db);
  const gitRoot = meaningfulGitRoot(cwdPath);
  const suggestedName = path.basename(detection.rootPath) || "default-project";

  const base = {
    cwd: cwdPath,
    rootPath: detection.rootPath,
    rootKey: detection.rootKey,
    detectionSource: detection.source,
    gitRoot,
    isGitRepository: gitRoot !== null,
    suggestedName,
  };

  if (detection.project) {
    const situation: WorkspaceSituation =
      detection.source === "exact" ? "project-linked" : "project-subfolder";
    return {
      ...base,
      situation,
      project: detection.project,
      reason:
        situation === "project-linked"
          ? `Directory is the registered root of project "${detection.project.name}"`
          : `Directory is inside the registered root of project "${detection.project.name}"`,
      canInitialize: false,
      requiresConfirmation: false,
    };
  }

  if (isAmbiguousLocation(cwdPath)) {
    return {
      ...base,
      situation: "ambiguous",
      project: null,
      reason:
        "Directory is a generic location (home, desktop, drive root or temp). It is not a product root.",
      canInitialize: false,
      requiresConfirmation: true,
    };
  }

  // Emptiness is checked before the git boundary: a folder with nothing in it
  // is a new product even when it happens to live under someone's dotfiles repo.
  if (isEmptyDirectory(cwdPath)) {
    return {
      ...base,
      situation: "empty-new",
      project: null,
      reason: "Directory is empty and can be initialised as a new product",
      canInitialize: true,
      requiresConfirmation: false,
    };
  }

  if (gitRoot) {
    const umbrella = findRegisteredAncestor(detection.rootKey, db);
    if (umbrella && normalizeRootPath(gitRoot) !== umbrella.root_key) {
      return {
        ...base,
        situation: "nested-independent-repo",
        project: null,
        reason: `Directory is its own git repository and must not be claimed by the umbrella project "${umbrella.name}"`,
        canInitialize: false,
        requiresConfirmation: true,
      };
    }
    return {
      ...base,
      situation: "existing-unregistered",
      project: null,
      reason: "Directory contains a git repository that is not registered yet",
      canInitialize: false,
      requiresConfirmation: true,
    };
  }

  return {
    ...base,
    situation: "existing-unregistered",
    project: null,
    reason: "Directory contains files but is not registered as a project",
    canInitialize: false,
    requiresConfirmation: true,
  };
}
