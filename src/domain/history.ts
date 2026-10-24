import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";

export interface HistoryItem {
  id: string;
  /** Null once the task row is deleted; the snapshot below keeps the record. */
  task_id: string | null;
  project_id: string;
  section_id: string | null;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  notes: string | null;
  tags: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string;
  cycle_time_seconds: number | null;
  total_cycle_time_ms: number | null;
  project_name?: string;
  section_name?: string | null;
  section_color?: string | null;
}

export interface PaginatedHistory {
  items: HistoryItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function sanitizeFtsQuery(query: string): string {
  // Remove SQLite FTS special characters that could cause syntax errors
  const cleaned = query.replace(/['"*^():]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  // Add prefix wildcard for better interactive search experience
  return words.map((w) => `"${w}"*`).join(" ");
}

export function searchHistory(
  projectId?: string,
  query?: string,
  limit: number = 50,
  db: Database = getDatabase()
): HistoryItem[] {
  const trimmed = query?.trim();

  if (trimmed) {
    const ftsTerm = sanitizeFtsQuery(trimmed);
    if (!ftsTerm) {
      return listHistory(projectId, 1, limit, db).items;
    }

    const conditions: string[] = [];
    const params: any[] = [ftsTerm];

    if (projectId) {
      conditions.push("h.project_id = ?");
      params.push(projectId);
    }
    params.push(limit);

    const extraConditions =
      conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT h.*, p.name as project_name
      FROM history h
      JOIN history_fts fts ON fts.id = h.id
      JOIN projects p ON h.project_id = p.id
      WHERE history_fts MATCH ?${extraConditions}
      ORDER BY bm25(history_fts), h.archived_at DESC
      LIMIT ?
    `;

    try {
      return db.query(sql).all(...params) as HistoryItem[];
    } catch {
      // Fallback to LIKE if MATCH fails due to special characters
      const likeTerm = `%${trimmed}%`;
      const likeConditions = ["(h.title LIKE ? OR h.description LIKE ? OR h.notes LIKE ?)"];
      const likeParams: any[] = [likeTerm, likeTerm, likeTerm];
      if (projectId) {
        likeConditions.push("h.project_id = ?");
        likeParams.push(projectId);
      }
      likeParams.push(limit);

      return db.query(`
        SELECT h.*, p.name as project_name
        FROM history h
        JOIN projects p ON h.project_id = p.id
        WHERE ${likeConditions.join(" AND ")}
        ORDER BY h.archived_at DESC
        LIMIT ?
      `).all(...likeParams) as HistoryItem[];
    }
  }

  return listHistory(projectId, 1, limit, db).items;
}

export function listHistory(
  projectId?: string,
  page: number = 1,
  limit: number = 20,
  db: Database = getDatabase()
): PaginatedHistory {
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: any[] = [];

  if (projectId) {
    conditions.push("h.project_id = ?");
    params.push(projectId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db
    .query(`SELECT COUNT(*) as total FROM history h ${whereClause}`)
    .get(...params) as { total: number };

  const total = Number(countRow?.total || 0);
  const totalPages = Math.ceil(total / limit) || 1;

  const queryParams = [...params, limit, offset];
  const items = db
    .query(`
      SELECT h.*, p.name as project_name
      FROM history h
      JOIN projects p ON h.project_id = p.id
      ${whereClause}
      ORDER BY h.archived_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...queryParams) as HistoryItem[];

  return {
    items,
    total,
    page,
    limit,
    totalPages,
  };
}

export function getHistoryItem(
  id: string,
  db: Database = getDatabase()
): HistoryItem | null {
  return db
    .query(`
      SELECT h.*, p.name as project_name
      FROM history h
      JOIN projects p ON h.project_id = p.id
      WHERE h.id = ?
    `)
    .get(id) as HistoryItem | null;
}
