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
  TASK_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskStatus,
  type TaskPriority,
  type TaskType,
} from "../domain/task.ts";
import { archiveDoneTasks } from "../domain/archive.ts";
import { listHistory, searchHistory } from "../domain/history.ts";
import { calculateProjectMetrics } from "../domain/efficiency.ts";

/** An error whose message is safe to return to the client. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message, status }, status);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }

  if (text.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }

  return parsed as Record<string, unknown>;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `"${field}" must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `"${field}" must be a string`);
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `"${field}" must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(
      422,
      `"${field}" has an unsupported value "${String(value)}". Allowed: ${allowed.join(", ")}.`
    );
  }
  return value as T;
}

function optionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new HttpError(400, `"${field}" must be an integer`);
  }
  if (parsed < min || parsed > max) {
    throw new HttpError(400, `"${field}" must be between ${min} and ${max}`);
  }
  return parsed;
}

function optionalTags(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.length > 500) throw new HttpError(400, `"tags" must be at most 500 characters`);
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    const joined = (value as string[]).join(",");
    if (joined.length > 500) throw new HttpError(400, `"tags" must be at most 500 characters`);
    return joined;
  }
  throw new HttpError(400, `"tags" must be a string or an array of strings`);
}

const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_COLOR_PATTERN = /^[a-zA-Z]{3,20}$/;

function optionalColor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, `"color" must be a string`);
  }
  const trimmed = value.trim();
  if (!COLOR_PATTERN.test(trimmed) && !NAMED_COLOR_PATTERN.test(trimmed)) {
    throw new HttpError(400, `"color" must be a hex colour (#rrggbb) or a CSS colour name`);
  }
  return trimmed;
}

interface IntParamOptions {
  min: number;
  max: number;
  fallback: number;
}

function intParam(url: URL, name: string, options: IntParamOptions): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return options.fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new HttpError(400, `"${name}" must be an integer`);
  }
  if (parsed < options.min || parsed > options.max) {
    throw new HttpError(400, `"${name}" must be between ${options.min} and ${options.max}`);
  }
  return parsed;
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
  db: Database = getDatabase(),
  token: string = ""
): Promise<Response | null> {
  const method = req.method.toUpperCase();
  const path = url.pathname;

  if (path === "/api/health") {
    if (method === "GET") {
      return jsonResponse({ ok: true, version: "0.1.0", token });
    }
    return errorResponse("Method not allowed", 405);
  }

  if (!path.startsWith("/api/")) {
    return null;
  }

  try {
    // --- Projects ---
    if (path === "/api/projects") {
      if (method === "GET") {
        return jsonResponse(listProjects(db));
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const created = createProject(
          {
            name: requireText(body.name, "name", 200),
            description: optionalText(body.description, "description", 2000) ?? undefined,
            rootPath: optionalText(body.rootPath, "rootPath", 4096) ?? undefined,
            archiveThresholdHours: optionalInt(body.archiveThresholdHours, "archiveThresholdHours", 0, 8760),
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
        const body = await readJsonBody(req);
        const updated = updateProject(
          projectId,
          {
            name: body.name === undefined ? undefined : requireText(body.name, "name", 200),
            description: optionalText(body.description, "description", 2000),
            root_path: optionalText(body.rootPath, "rootPath", 4096),
            archive_threshold_hours: optionalInt(
              body.archiveThresholdHours,
              "archiveThresholdHours",
              0,
              8760
            ),
          },
          db
        );
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
        return jsonResponse(listSections(projectId, db));
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const section = createSection(
          {
            projectId,
            name: requireText(body.name, "name", 120),
            color: optionalColor(body.color),
            position: optionalInt(body.position, "position", 0, 100_000),
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
        const body = await readJsonBody(req);
        const updated = updateSection(
          sectionId,
          {
            name: body.name === undefined ? undefined : requireText(body.name, "name", 120),
            color: optionalColor(body.color),
            position: optionalInt(body.position, "position", 0, 100_000),
          },
          db
        );
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
      return jsonResponse(getKanbanBoard(projectId, sectionId, db));
    }

    const backlogMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/backlog$/);
    if (backlogMatch && method === "GET") {
      const projectId = backlogMatch;
      const sectionId = url.searchParams.get("sectionId") || undefined;
      return jsonResponse(listTasks(projectId, { status: ["backlog", "todo"], sectionId }, db));
    }

    // --- Project Tasks ---
    const projectTasksMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch) {
      const projectId = projectTasksMatch;
      if (method === "GET") {
        const status = optionalEnum(
          url.searchParams.get("status") ?? undefined,
          "status",
          TASK_STATUSES
        );
        const priority = optionalEnum(
          url.searchParams.get("priority") ?? undefined,
          "priority",
          TASK_PRIORITIES
        );
        const type = optionalEnum(
          url.searchParams.get("type") ?? undefined,
          "type",
          TASK_TYPES
        );
        const sectionId = url.searchParams.get("sectionId") || undefined;

        return jsonResponse(
          listTasks(projectId, { status, sectionId, priority, type }, db)
        );
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const created = createTask(
          {
            projectId,
            title: requireText(body.title, "title", 500),
            description: optionalText(body.description, "description", 20_000) ?? undefined,
            sectionId: optionalText(body.sectionId, "sectionId", 200) ?? undefined,
            type: optionalEnum(body.type, "type", TASK_TYPES) as TaskType | undefined,
            priority: optionalEnum(body.priority, "priority", TASK_PRIORITIES) as
              | TaskPriority
              | undefined,
            status: optionalEnum(body.status, "status", TASK_STATUSES),
            position: optionalInt(body.position, "position", -100_000, 100_000),
            storyPoints: optionalInt(body.storyPoints, "storyPoints", 0, 100),
            tags: optionalTags(body.tags),
            notes: optionalText(body.notes, "notes", 20_000) ?? undefined,
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
        const body = await readJsonBody(req);
        const updated = updateTask(
          taskId,
          {
            title: body.title === undefined ? undefined : requireText(body.title, "title", 500),
            description: optionalText(body.description, "description", 20_000),
            priority: optionalEnum(body.priority, "priority", TASK_PRIORITIES),
            type: optionalEnum(body.type, "type", TASK_TYPES),
            section_id: body.section_id === undefined
              ? undefined
              : body.section_id === null
                ? null
                : requireText(body.section_id, "section_id", 200),
            status: optionalEnum(body.status, "status", TASK_STATUSES),
            position: optionalInt(body.position, "position", -100_000, 100_000),
            story_points: optionalInt(body.story_points ?? body.storyPoints, "story_points", 0, 100),
            tags: optionalTags(body.tags),
            notes: optionalText(body.notes, "notes", 20_000),
          },
          db
        );
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
      const started = startTask(startMatch, db);
      if (!started) return errorResponse("Task not found", 404);
      return jsonResponse(started);
    }

    // Complete task
    const completeMatch = pathParam(path, /^\/api\/tasks\/([^/]+)\/complete$/);
    if (completeMatch && method === "POST") {
      const body = await readJsonBody(req);
      const completed = completeTask(
        completeMatch,
        optionalText(body.notes, "notes", 20_000) ?? undefined,
        db
      );
      if (!completed) return errorResponse("Task not found", 404);
      return jsonResponse(completed);
    }

    // Status update convenience route
    const statusMatch = pathParam(path, /^\/api\/tasks\/([^/]+)\/status$/);
    if (statusMatch && method === "PATCH") {
      const body = await readJsonBody(req);
      const status = optionalEnum(body.status, "status", TASK_STATUSES) as TaskStatus | undefined;
      if (!status) {
        throw new HttpError(400, `"status" is required`);
      }
      const updated = updateTask(
        statusMatch,
        { status, notes: optionalText(body.notes, "notes", 20_000) ?? undefined },
        db
      );
      if (!updated) return errorResponse("Task not found", 404);
      return jsonResponse(updated);
    }

    // --- Archive ---
    const archiveMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/(?:archive|archive-done)$/);
    if (archiveMatch && method === "POST") {
      const body = await readJsonBody(req);
      const forceManual = body.forceManual === undefined ? true : Boolean(body.forceManual);
      const thresholdHours = optionalInt(body.thresholdHours, "thresholdHours", 0, 8760);
      const result = archiveDoneTasks(archiveMatch, forceManual, thresholdHours, db);
      return jsonResponse(result);
    }

    // --- History & Changelog ---
    const historyMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/history$/);
    if (historyMatch && method === "GET") {
      const projectId = historyMatch;
      const query = url.searchParams.get("query") || url.searchParams.get("q") || undefined;
      const page = intParam(url, "page", { min: 1, max: 10_000, fallback: 1 });
      const limit = intParam(url, "limit", { min: 1, max: 200, fallback: 20 });

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

      return jsonResponse(listHistory(projectId, page, limit, db));
    }

    // --- Metrics & Efficiency ---
    const metricsMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/(?:metrics|efficiency)$/);
    if (metricsMatch && method === "GET") {
      const projectId = metricsMatch;
      const days = intParam(url, "days", { min: 1, max: 3650, fallback: 30 });
      return jsonResponse(calculateProjectMetrics(projectId, days, db));
    }

    return errorResponse(`Endpoint not found: ${method} ${path}`, 404);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.message, err.status);
    }
    if (err instanceof TaskValidationError) {
      return errorResponse(err.message, 422);
    }

    // Technical detail stays in the server log; the client gets a generic error.
    console.error("API error:", err);
    return errorResponse("Internal server error", 500);
  }
}
