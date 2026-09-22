import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { getDatabase } from "../db/connection.ts";

export interface Section {
  id: string;
  project_id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
}

export const DEFAULT_SECTIONS = [
  { name: "General", color: "#6366f1", position: 0 },
  { name: "Frontend", color: "#3b82f6", position: 1 },
  { name: "Backend", color: "#10b981", position: 2 },
  { name: "Bugfixes", color: "#ef4444", position: 3 },
];

export function seedDefaultSections(
  projectId: string,
  db: Database = getDatabase()
): Section[] {
  const existing = db
    .query("SELECT COUNT(*) as count FROM sections WHERE project_id = ?")
    .get(projectId) as { count: number };

  if (existing && existing.count > 0) {
    return listSections(projectId, db);
  }

  const sections: Section[] = [];
  const stmt = db.prepare(
    `INSERT INTO sections (id, project_id, name, color, position)
     VALUES (?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    for (const item of DEFAULT_SECTIONS) {
      const id = crypto.randomUUID();
      stmt.run(id, projectId, item.name, item.color, item.position);
    }
  })();

  return listSections(projectId, db);
}

export function createSection(
  data: {
    projectId: string;
    name: string;
    color?: string;
    position?: number;
  },
  db: Database = getDatabase()
): Section {
  const id = crypto.randomUUID();
  let pos = data.position;

  if (pos === undefined) {
    const maxPosRow = db
      .query("SELECT MAX(position) as max_pos FROM sections WHERE project_id = ?")
      .get(data.projectId) as { max_pos: number | null };
    pos = (maxPosRow?.max_pos ?? -1) + 1;
  }

  db.run(
    `INSERT INTO sections (id, project_id, name, color, position)
     VALUES (?, ?, ?, ?, ?)`,
    [id, data.projectId, data.name, data.color || "#6366f1", pos]
  );

  return db.query("SELECT * FROM sections WHERE id = ?").get(id) as Section;
}

export function listSections(
  projectId: string,
  db: Database = getDatabase()
): Section[] {
  return db
    .query("SELECT * FROM sections WHERE project_id = ? ORDER BY position ASC, created_at ASC")
    .all(projectId) as Section[];
}

export function getSection(
  id: string,
  db: Database = getDatabase()
): Section | null {
  return db.query("SELECT * FROM sections WHERE id = ?").get(id) as Section | null;
}

export function updateSection(
  id: string,
  updates: Partial<Pick<Section, "name" | "color" | "position">>,
  db: Database = getDatabase()
): Section | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.color !== undefined) {
    fields.push("color = ?");
    values.push(updates.color);
  }
  if (updates.position !== undefined) {
    fields.push("position = ?");
    values.push(updates.position);
  }

  if (fields.length === 0) {
    return getSection(id, db);
  }

  values.push(id);
  db.run(`UPDATE sections SET ${fields.join(", ")} WHERE id = ?`, values);
  return getSection(id, db);
}

export function deleteSection(id: string, db: Database = getDatabase()): boolean {
  const result = db.run("DELETE FROM sections WHERE id = ?", [id]);
  return result.changes > 0;
}
