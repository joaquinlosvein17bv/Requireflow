import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";
import { seedDefaultSections } from "./section.ts";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  root_path: string | null;
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

export function resolveCurrentProject(
  cwd: string = process.cwd(),
  db: Database = getDatabase()
): Project {
  const gitRoot = findGitRoot(cwd);
  const targetPath = gitRoot || path.resolve(cwd);
  const projectName = path.basename(targetPath) || "default-project";

  return getOrCreateProject(projectName, targetPath, db);
}

export function getOrCreateProject(
  name: string,
  rootPath?: string,
  db: Database = getDatabase()
): Project {
  const existing = db
    .query("SELECT * FROM projects WHERE name = ?")
    .get(name) as Project | null;

  if (existing) {
    if (rootPath && existing.root_path !== rootPath) {
      db.run(
        "UPDATE projects SET root_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [rootPath, existing.id]
      );
      return { ...existing, root_path: rootPath };
    }
    return existing;
  }

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO projects (id, name, description, root_path, archive_threshold_hours)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, `Project for ${name}`, rootPath || null, 24]
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
  db.run(
    `INSERT INTO projects (id, name, description, root_path, archive_threshold_hours)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.description || null,
      data.rootPath || null,
      data.archiveThresholdHours ?? 24,
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
  updates: Partial<Pick<Project, "name" | "description" | "root_path" | "archive_threshold_hours">>,
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
  }
  if (updates.archive_threshold_hours !== undefined) {
    fields.push("archive_threshold_hours = ?");
    values.push(updates.archive_threshold_hours);
  }

  if (fields.length === 0) {
    return getProject(id, db);
  }

  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  db.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, values);
  return getProject(id, db);
}

export function deleteProject(id: string, db: Database = getDatabase()): boolean {
  const result = db.run("DELETE FROM projects WHERE id = ?", [id]);
  return result.changes > 0;
}
