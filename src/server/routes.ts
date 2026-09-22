import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  resolveCurrentProject,
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
        const cwdParam = url.searchParams.get("cwd") || process.cwd();
        const current = resolveCurrentProject(cwdParam, db);
        return jsonResponse(current);
      }
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
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
    const projectSectionsMatch = path.match(/^\/api\/projects\/([^/]+)\/sections$/);
    if (projectSectionsMatch) {
      const projectId = projectSectionsMatch[1];
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

    const sectionMatch = path.match(/^\/api\/sections\/([^/]+)$/);
    if (sectionMatch) {
      const sectionId = sectionMatch[1];
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
    const boardMatch = path.match(/^\/api\/projects\/([^/]+)\/board$/);
    if (boardMatch && method === "GET") {
      const projectId = boardMatch[1];
      const sectionId = url.searchParams.get("sectionId") || undefined;
      const board = getKanbanBoard(projectId, sectionId, db);
      return jsonResponse(board);
    }

    const backlogMatch = path.match(/^\/api\/projects\/([^/]+)\/backlog$/);
    if (backlogMatch && method === "GET") {
      const projectId = backlogMatch[1];
      const sectionId = url.searchParams.get("sectionId") || undefined;
      const tasks = listTasks(projectId, { status: ["backlog", "todo"], sectionId }, db);
      return jsonResponse(tasks);
    }

    // --- Project Tasks ---
    const projectTasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch) {
      const projectId = projectTasksMatch[1];
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
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
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
    const startMatch = path.match(/^\/api\/tasks\/([^/]+)\/start$/);
    if (startMatch && method === "POST") {
      const taskId = startMatch[1];
      const started = startTask(taskId, db);
      if (!started) return errorResponse("Task not found", 404);
      return jsonResponse(started);
    }

    // Complete task
    const completeMatch = path.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (completeMatch && method === "POST") {
      const taskId = completeMatch[1];
      const body = await parseJsonBody(req);
      const completed = completeTask(taskId, body.notes, db);
      if (!completed) return errorResponse("Task not found", 404);
      return jsonResponse(completed);
    }

    // Status update convenience route
    const statusMatch = path.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (statusMatch && method === "PATCH") {
      const taskId = statusMatch[1];
      const body = await parseJsonBody(req);
      if (!body.status) return errorResponse("Status is required", 400);
      const updated = updateTask(taskId, { status: body.status, notes: body.notes }, db);
      if (!updated) return errorResponse("Task not found", 404);
      return jsonResponse(updated);
    }

    // --- Archive ---
    const archiveMatch = path.match(/^\/api\/projects\/([^/]+)\/(?:archive|archive-done)$/);
    if (archiveMatch && method === "POST") {
      const projectId = archiveMatch[1];
      const body = await parseJsonBody(req);
      const forceManual = body.forceManual !== undefined ? Boolean(body.forceManual) : true;
      const thresholdHours = body.thresholdHours !== undefined ? Number(body.thresholdHours) : undefined;
      const result = archiveDoneTasks(projectId, forceManual, thresholdHours, db);
      return jsonResponse(result);
    }

    // --- History & Changelog ---
    const historyMatch = path.match(/^\/api\/projects\/([^/]+)\/history$/);
    if (historyMatch && method === "GET") {
      const projectId = historyMatch[1];
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
    const metricsMatch = path.match(/^\/api\/projects\/([^/]+)\/(?:metrics|efficiency)$/);
    if (metricsMatch && method === "GET") {
      const projectId = metricsMatch[1];
      const days = parseInt(url.searchParams.get("days") || "30", 10);
      const metrics = calculateProjectMetrics(projectId, days, db);
      return jsonResponse(metrics);
    }

    return errorResponse(`Endpoint not found: ${method} ${path}`, 404);
  } catch (err: any) {
    console.error("API error:", err);
    return errorResponse(err?.message || "Internal server error", 500);
  }
}
