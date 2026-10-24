import { Database } from "bun:sqlite";
import fs from "node:fs";
import nodePath from "node:path";
import { getDatabase } from "../db/connection.ts";
import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  detectProject,
} from "../domain/project.ts";
import {
  listSections,
  createSection,
  updateSection,
  deleteSection,
} from "../domain/section.ts";
import {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  startTask,
  completeTask,
  getKanbanBoard,
  TaskValidationError,
  type TaskStatus,
  type TaskPriority,
  type TaskType,
} from "../domain/task.ts";
import { archiveDoneTasks } from "../domain/archive.ts";
import { listHistory, searchHistory } from "../domain/history.ts";
import { calculateProjectMetrics } from "../domain/efficiency.ts";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message, status }, status);
}

async function parseJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * Extracts the first capturing group of a path pattern.
 * Returns null when the path does not match, keeping call sites free of
 * undefined-able index access.
 */
function pathParam(path: string, pattern: RegExp): string | null {
  const match = path.match(pattern);
  const value = match?.[1];
  return value === undefined || value.length === 0 ? null : value;
}

type DirectoryValidation =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** Validates a directory supplied by a client before touching the database. */
function validateDirectory(input: string): DirectoryValidation {
  if (input.trim().length === 0) {
    return { ok: false, error: "cwd must be a non-empty path" };
  }
  if (input.length > 4096) {
    return { ok: false, error: "cwd must be shorter than 4096 characters" };
  }
  if (input.includes("\0")) {
    return { ok: false, error: "cwd contains invalid characters" };
  }

  const resolved = nodePath.resolve(input);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `Directory not found: ${resolved}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `Not a directory: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

export async function handleApiRoute(
  req: Request,
  url: URL,
  db: Database = getDatabase()
): Promise<Response | null> {
  const method = req.method.toUpperCase();
  const path = url.pathname;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (!path.startsWith("/api/")) {
    return null;
  }

  try {
    // --- Projects ---
    if (path === "/api/projects") {
      if (method === "GET") {
        const projects = listProjects(db);
        return jsonResponse(projects);
      }
      if (method === "POST") {
        const body = await parseJsonBody(req);
        if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
          return errorResponse("Project name is required", 400);
        }
        const created = createProject(
          {
            name: body.name.trim(),
            description: body.description,
            rootPath: body.rootPath,
            archiveThresholdHours: body.archiveThresholdHours,
          },
          db
        );
        return jsonResponse(created, 201);
      }
    }

    if (path === "/api/projects/current") {
      if (method === "GET") {
        const cwdParam = url.searchParams.get("cwd");

        // Detection is read-only: a GET must never register a project. The
        // previous behaviour created one for any path that reached this route.
        if (cwdParam !== null) {
          const validation = validateDirectory(cwdParam);
          if (!validation.ok) {
            return errorResponse(validation.error, 400);
          }
        }

        const target = cwdParam ?? process.cwd();
        const detection = detectProject(target, db);

        if (!detection.project) {
          return jsonResponse(
            {
              error: "No project is registered for this directory",
              detected_root: detection.rootPath,
              root_key: detection.rootKey,
              suggested_name: nodePath.basename(detection.rootPath) || "default-project",
              hint: "Create it with POST /api/projects { name, rootPath } or `requireflow init`.",
            },
            404
          );
        }

        return jsonResponse({
          ...detection.project,
          is_directory_linked: true,
          detection_source: detection.source,
          detected_root: detection.rootPath,
        });
      }
    }

    const projectMatch = pathParam(path, /^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = projectMatch;
      if (method === "GET") {
        const project = getProject(projectId, db);
        if (!project) return errorResponse("Project not found", 404);
        return jsonResponse(project);
      }
      if (method === "PATCH") {
        const body = await parseJsonBody(req);
        const updated = updateProject(projectId, body, db);
        if (!updated) return errorResponse("Project not found", 404);
        return jsonResponse(updated);
      }
      if (method === "DELETE") {
        const deleted = deleteProject(projectId, db);
        if (!deleted) return errorResponse("Project not found", 404);
        return jsonResponse({ success: true });
      }
    }

    // --- Sections ---
    const projectSectionsMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/sections$/);
    if (projectSectionsMatch) {
      const projectId = projectSectionsMatch;
      if (method === "GET") {
        const sections = listSections(projectId, db);
        return jsonResponse(sections);
      }
      if (method === "POST") {
        const body = await parseJsonBody(req);
        if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
          return errorResponse("Section name is required", 400);
        }
        const section = createSection(
          {
            projectId,
            name: body.name.trim(),
            color: body.color,
            position: body.position,
          },
          db
        );
        return jsonResponse(section, 201);
      }
    }

    const sectionMatch = pathParam(path, /^\/api\/sections\/([^/]+)$/);
    if (sectionMatch) {
      const sectionId = sectionMatch;
      if (method === "PATCH") {
        const body = await parseJsonBody(req);
        const updated = updateSection(sectionId, body, db);
        if (!updated) return errorResponse("Section not found", 404);
        return jsonResponse(updated);
      }
      if (method === "DELETE") {
        const deleted = deleteSection(sectionId, db);
        if (!deleted) return errorResponse("Section not found", 404);
        return jsonResponse({ success: true });
      }
    }

    // --- Kanban Board & Backlog ---
    const boardMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/board$/);
    if (boardMatch && method === "GET") {
      const projectId = boardMatch;
      const sectionId = url.searchParams.get("sectionId") || undefined;
      const board = getKanbanBoard(projectId, sectionId, db);
      return jsonResponse(board);
    }

    const backlogMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/backlog$/);
    if (backlogMatch && method === "GET") {
      const projectId = backlogMatch;
      const sectionId = url.searchParams.get("sectionId") || undefined;
      const tasks = listTasks(projectId, { status: ["backlog", "todo"], sectionId }, db);
      return jsonResponse(tasks);
    }

    // --- Project Tasks ---
    const projectTasksMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch) {
      const projectId = projectTasksMatch;
      if (method === "GET") {
        const status = url.searchParams.get("status") as TaskStatus | null;
        const sectionId = url.searchParams.get("sectionId") || undefined;
        const priority = url.searchParams.get("priority") as TaskPriority | null;
        const type = url.searchParams.get("type") as TaskType | null;

        const tasks = listTasks(
          projectId,
          {
            status: status || undefined,
            sectionId,
            priority: priority || undefined,
            type: type || undefined,
          },
          db
        );
        return jsonResponse(tasks);
      }
      if (method === "POST") {
        const body = await parseJsonBody(req);
        if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
          return errorResponse("Task title is required", 400);
        }
        const created = createTask(
          {
            projectId,
            title: body.title.trim(),
            description: body.description,
            sectionId: body.sectionId,
            type: body.type,
            priority: body.priority,
            status: body.status,
            position: body.position,
            storyPoints: body.storyPoints,
            tags: body.tags,
            notes: body.notes,
          },
          db
        );
        return jsonResponse(created, 201);
      }
    }

    // --- Individual Tasks ---
    const taskMatch = pathParam(path, /^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = taskMatch;
      if (method === "GET") {
        const task = getTask(taskId, db);
        if (!task) return errorResponse("Task not found", 404);
        return jsonResponse(task);
      }
      if (method === "PATCH") {
        const body = await parseJsonBody(req);
        const updated = updateTask(taskId, body, db);
        if (!updated) return errorResponse("Task not found", 404);
        return jsonResponse(updated);
      }
      if (method === "DELETE") {
        const deleted = deleteTask(taskId, db);
        if (!deleted) return errorResponse("Task not found", 404);
        return jsonResponse({ success: true });
      }
    }

    // Start task
    const startMatch = pathParam(path, /^\/api\/tasks\/([^/]+)\/start$/);
    if (startMatch && method === "POST") {
      const taskId = startMatch;
      const started = startTask(taskId, db);
      if (!started) return errorResponse("Task not found", 404);
      return jsonResponse(started);
    }

    // Complete task
    const completeMatch = pathParam(path, /^\/api\/tasks\/([^/]+)\/complete$/);
    if (completeMatch && method === "POST") {
      const taskId = completeMatch;
      const body = await parseJsonBody(req);
      const completed = completeTask(taskId, body.notes, db);
      if (!completed) return errorResponse("Task not found", 404);
      return jsonResponse(completed);
    }

    // Status update convenience route
    const statusMatch = pathParam(path, /^\/api\/tasks\/([^/]+)\/status$/);
    if (statusMatch && method === "PATCH") {
      const taskId = statusMatch;
      const body = await parseJsonBody(req);
      if (!body.status) return errorResponse("Status is required", 400);
      const updated = updateTask(taskId, { status: body.status, notes: body.notes }, db);
      if (!updated) return errorResponse("Task not found", 404);
      return jsonResponse(updated);
    }

    // --- Archive ---
    const archiveMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/(?:archive|archive-done)$/);
    if (archiveMatch && method === "POST") {
      const projectId = archiveMatch;
      const body = await parseJsonBody(req);
      const forceManual = body.forceManual !== undefined ? Boolean(body.forceManual) : true;
      const thresholdHours = body.thresholdHours !== undefined ? Number(body.thresholdHours) : undefined;
      const result = archiveDoneTasks(projectId, forceManual, thresholdHours, db);
      return jsonResponse(result);
    }

    // --- History & Changelog ---
    const historyMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/history$/);
    if (historyMatch && method === "GET") {
      const projectId = historyMatch;
      const query = url.searchParams.get("query") || url.searchParams.get("q") || undefined;
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);

      if (query) {
        const items = searchHistory(projectId, query, limit, db);
        return jsonResponse({
          items,
          total: items.length,
          page: 1,
          limit,
          totalPages: 1,
        });
      }

      const paginated = listHistory(projectId, page, limit, db);
      return jsonResponse(paginated);
    }

    // --- Metrics & Efficiency ---
    const metricsMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/(?:metrics|efficiency)$/);
    if (metricsMatch && method === "GET") {
      const projectId = metricsMatch;
      const days = parseInt(url.searchParams.get("days") || "30", 10);
      const metrics = calculateProjectMetrics(projectId, days, db);
      return jsonResponse(metrics);
    }

    return errorResponse(`Endpoint not found: ${method} ${path}`, 404);
  } catch (err: any) {
    console.error("API error:", err);
    if (err instanceof TaskValidationError) {
      return errorResponse(err.message, 422);
    }
    return errorResponse(err?.message || "Internal server error", 500);
  }
}
