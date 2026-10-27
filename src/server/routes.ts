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
  classifyWorkspace,
  setProjectMode,
  isProjectMode,
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
import { listChanges } from "../domain/changelog.ts";
import {
  createIdea,
  createWorkItem,
  getBacklogTree,
  getWorkItem,
  updateWorkItem,
  discardWorkItem,
  WorkItemConflictError,
  WorkItemValidationError,
  WORK_ITEM_DEFINITIONS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  type WorkItemDefinition,
  type WorkItemPriority,
  type WorkItemStatus,
} from "../domain/backlog/work-item.ts";
import { PlanValidationError } from "../domain/backlog/scope.ts";
import {
  addAcceptanceCriterion,
  recordDecision,
  retireAcceptanceCriterion,
  supersedeAcceptanceCriterion,
} from "../domain/backlog/criteria.ts";
import {
  approveIncrement,
  getIncrement,
  getIncrementView,
  INCREMENT_STATUSES,
  listIncrements,
  nextIncrement,
  proposeGroups,
  refineIncrement,
  type IncrementStatus,
} from "../domain/backlog/increment.ts";
import {
  acceptIncrement,
  deliverCorrection,
  listFindings,
  listReviewResults,
  listReviews,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
} from "../domain/backlog/review.ts";

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

/** A version conflict is not a client mistake: it carries the current state. */
function conflictResponse(message: string, current: unknown): Response {
  return jsonResponse({ error: message, status: 409, current }, 409);
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

/** Actor attribution for local calls; never evidence of human presence. */
function actorFromRequest(req: Request): string {
  const header = req.headers.get("x-requireflow-actor");
  if (header && header.trim() !== "") return header.trim();
  return "user:local";
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
            mode: optionalEnum(body.mode, "mode", ["legacy", "product"] as const),
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

    // --- Workspace classification (read-only) ---
    if (path === "/api/workspace/classify") {
      if (method === "GET") {
        const cwdParam = url.searchParams.get("cwd");
        if (cwdParam !== null) {
          const validation = validateDirectory(cwdParam);
          if (!validation.ok) {
            return errorResponse(validation.error, 400);
          }
        }
        return jsonResponse(classifyWorkspace(cwdParam ?? process.cwd(), db));
      }
      return errorResponse("Method not allowed", 405);
    }

    // --- Project mode ---
    const modeMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/mode$/);
    if (modeMatch) {
      if (method === "GET") {
        const project = getProject(modeMatch, db);
        if (!project) return errorResponse("Project not found", 404);
        return jsonResponse({ projectId: modeMatch, mode: project.mode });
      }
      if (method === "PATCH") {
        const body = await readJsonBody(req);
        if (!isProjectMode(body.mode)) {
          return errorResponse(`"mode" must be one of: legacy, product`, 422);
        }
        const updated = setProjectMode(modeMatch, body.mode, actorFromRequest(req), db);
        if (!updated) return errorResponse("Project not found", 404);
        return jsonResponse(updated);
      }
      return errorResponse("Method not allowed", 405);
    }

    // --- Ideas: fast capture, never executable work ---
    const ideasMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/ideas$/);
    if (ideasMatch) {
      if (method === "POST") {
        const body = await readJsonBody(req);
        const result = createIdea(
          {
            projectId: ideasMatch,
            text: requireText(body.text, "text", 20_000),
            title: optionalText(body.title, "title", 200) ?? undefined,
            operationKey: optionalText(body.operationKey, "operationKey", 200) ?? undefined,
            actor: actorFromRequest(req),
          },
          db
        );
        return jsonResponse(
          {
            item: result.item,
            duplicate_of: result.duplicateOf?.id ?? null,
            deduplicated: result.deduplicated,
          },
          result.deduplicated ? 200 : 201
        );
      }
      if (method === "GET") {
        return jsonResponse(getBacklogTree(ideasMatch, db).ideas);
      }
      return errorResponse("Method not allowed", 405);
    }

    // --- Product backlog tree (ideas, epics, stories) ---
    const planningMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/planning$/);
    if (planningMatch && method === "GET") {
      return jsonResponse(getBacklogTree(planningMatch, db));
    }

    // --- Create epics and stories ---
    const workItemsMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/work-items$/);
    if (workItemsMatch && method === "POST") {
      const body = await readJsonBody(req);
      const kind = optionalEnum(body.kind, "kind", ["epic", "story"] as const);
      if (!kind) {
        return errorResponse(`"kind" must be "epic" or "story"`, 422);
      }
      const created = createWorkItem(
        {
          projectId: workItemsMatch,
          kind,
          title: requireText(body.title, "title", 200),
          description: optionalText(body.description, "description", 20_000) ?? undefined,
          parentId: optionalText(body.parentId, "parentId", 200) ?? undefined,
          priority: optionalEnum(body.priority, "priority", WORK_ITEM_PRIORITIES),
          status: optionalEnum(body.status, "status", WORK_ITEM_STATUSES),
          actor: actorFromRequest(req),
        },
        db
      );
      return jsonResponse(created, 201);
    }

    // --- Append-only change log ---
    const changesMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/changes$/);
    if (changesMatch && method === "GET") {
      const limit = intParam(url, "limit", { min: 1, max: 500, fallback: 50 });
      return jsonResponse(listChanges(changesMatch, limit, db));
    }

    // --- Product groups (project scoped) ---
    const groupsMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/groups$/);
    if (groupsMatch) {
      if (method === "GET") {
        return jsonResponse(
          listIncrements(groupsMatch, db).map((group) => getIncrementView(group.id, db))
        );
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.groups) || body.groups.length === 0) {
          return errorResponse(`"groups" must be a non-empty array`);
        }
        return jsonResponse(
          proposeGroups(groupsMatch, body.groups as any, actorFromRequest(req), db),
          201
        );
      }
      return errorResponse("Method not allowed", 405);
    }

    const nextGroupMatch = pathParam(path, /^\/api\/projects\/([^/]+)\/groups\/next$/);
    if (nextGroupMatch && method === "GET") {
      const next = nextIncrement(nextGroupMatch, db);
      if (!next) {
        return jsonResponse({ group: null, message: "All groups are accepted" });
      }
      return jsonResponse({
        group: getIncrementView(next.increment.id, db),
        blocked: next.blocked,
        blockers: next.blockers,
      });
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
            workItemId: optionalText(body.workItemId, "workItemId", 200) ?? undefined,
            oddTaskRef: optionalText(body.oddTaskRef, "oddTaskRef", 200) ?? undefined,
          },
          db
        );
        return jsonResponse(created, 201);
      }
    }

    // --- Individual group ---
    const groupAction = path.match(/^\/api\/groups\/([^/]+)\/([a-z]+)$/);
    if (groupAction && method === "POST") {
      const groupId = groupAction[1]!;
      const action = groupAction[2]!;
      const group = getIncrement(groupId, db);
      if (!group) return errorResponse("Group not found", 404);
      const body = await readJsonBody(req);

      switch (action) {
        case "approve": {
          const expectedVersion = optionalInt(
            body.expectedVersion,
            "expectedVersion",
            1,
            Number.MAX_SAFE_INTEGER
          );
          if (expectedVersion === undefined) {
            return errorResponse(`"expectedVersion" is required`);
          }
          const confirm = requireText(body.confirm, "confirm", 100);
          if (confirm !== `APROBAR ${group.code}`) {
            return errorResponse(`Confirmation must be exactly "APROBAR ${group.code}"`, 422);
          }
          return jsonResponse(
            approveIncrement(group.id, { expectedVersion, actor: "human:ui" }, db)
          );
        }
        case "accept": {
          const expectedVersion = optionalInt(
            body.expectedVersion,
            "expectedVersion",
            1,
            Number.MAX_SAFE_INTEGER
          );
          if (expectedVersion === undefined) {
            return errorResponse(`"expectedVersion" is required`);
          }
          const confirm = requireText(body.confirm, "confirm", 100);
          if (confirm !== `ACEPTAR ${group.code}`) {
            return errorResponse(`Confirmation must be exactly "ACEPTAR ${group.code}"`, 422);
          }
          const evidence = optionalText(body.evidence, "evidence", 20_000) ?? undefined;
          return jsonResponse(
            acceptIncrement(
              { incrementId: group.id, actor: "human:ui", expectedVersion, evidence },
              db
            )
          );
        }
        case "start":
          return jsonResponse(startImplementation(group.id, actorFromRequest(req), db));
        case "evidence": {
          const evidence = requireText(body.evidence, "evidence", 20_000);
          const notes = optionalText(body.notes, "notes", 20_000) ?? undefined;
          return jsonResponse(
            submitImplementationEvidence(
              { incrementId: group.id, actor: "agent:odd", evidence, notes },
              db
            )
          );
        }
        case "defects": {
          const description = requireText(body.description, "description", 5_000);
          const criterionCode =
            optionalText(body.acceptanceCriterionCode, "acceptanceCriterionCode", 100) ?? undefined;
          return jsonResponse(
            reportDefect(
              {
                incrementId: group.id,
                actor: actorFromRequest(req),
                description,
                acceptanceCriterionCode: criterionCode,
              },
              db
            )
          );
        }
        case "corrections": {
          const evidence = requireText(body.evidence, "evidence", 20_000);
          return jsonResponse(
            deliverCorrection({ incrementId: group.id, actor: "agent:odd", evidence }, db)
          );
        }
        case "criteria": {
          const text = requireText(body.text, "text", 2_000);
          return jsonResponse(
            addAcceptanceCriterion(
              { incrementId: group.id, text, actor: actorFromRequest(req) },
              db
            ),
            201
          );
        }
        case "decisions": {
          const title = requireText(body.title, "title", 200);
          const question = requireText(body.question, "question", 2_000);
          const answer = requireText(body.answer, "answer", 5_000);
          return jsonResponse(
            recordDecision(
              {
                projectId: group.project_id,
                incrementId: group.id,
                title,
                question,
                answer,
                actor: actorFromRequest(req),
              },
              db
            ),
            201
          );
        }
        default:
          return errorResponse(`Unknown group action: ${action}`, 404);
      }
    }

    const groupMatch = pathParam(path, /^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const group = getIncrement(groupMatch, db);
      if (!group) return errorResponse("Group not found", 404);

      if (method === "GET") {
        const view = getIncrementView(group.id, db);
        const reviews = listReviews(group.id, db).map((review) => ({
          ...review,
          findings: listFindings(review.id, db),
          results: listReviewResults(review.id, db),
        }));
        return jsonResponse({ ...view, reviews });
      }

      if (method === "PATCH") {
        const body = await readJsonBody(req);
        const expectedVersion = optionalInt(
          body.expectedVersion,
          "expectedVersion",
          1,
          Number.MAX_SAFE_INTEGER
        );
        if (expectedVersion === undefined) {
          return errorResponse(`"expectedVersion" is required`);
        }
        return jsonResponse(
          refineIncrement(
            group.id,
            expectedVersion,
            {
              name: body.name === undefined ? undefined : requireText(body.name, "name", 200),
              goal: body.goal === undefined ? undefined : requireText(body.goal, "goal", 2_000),
              exclusiones: optionalText(body.exclusiones, "exclusiones", 5_000),
              addStoryIds: Array.isArray(body.addStoryIds)
                ? (body.addStoryIds as string[])
                : undefined,
              removeStoryIds: Array.isArray(body.removeStoryIds)
                ? (body.removeStoryIds as string[])
                : undefined,
              addDependencyCodes: Array.isArray(body.addDependencyCodes)
                ? (body.addDependencyCodes as string[])
                : undefined,
              status:
                body.status === undefined
                  ? undefined
                  : (optionalEnum(
                      body.status,
                      "status",
                      INCREMENT_STATUSES
                    ) as IncrementStatus),
            },
            actorFromRequest(req),
            db
          )
        );
      }

      return errorResponse("Method not allowed", 405);
    }

    // --- Acceptance criteria lifecycle ---
    const criterionMatch = pathParam(path, /^\/api\/criteria\/([^/]+)$/);
    if (criterionMatch) {
      const body = await readJsonBody(req);
      const expectedVersion = optionalInt(
        body.expectedVersion,
        "expectedVersion",
        1,
        Number.MAX_SAFE_INTEGER
      );
      if (expectedVersion === undefined) {
        return errorResponse(`"expectedVersion" is required`);
      }

      if (method === "PATCH") {
        const text = requireText(body.text, "text", 2_000);
        return jsonResponse(
          supersedeAcceptanceCriterion(
            criterionMatch,
            expectedVersion,
            text,
            actorFromRequest(req),
            db
          )
        );
      }
      if (method === "DELETE") {
        const reason = requireText(body.reason, "reason", 1_000);
        return jsonResponse(
          retireAcceptanceCriterion(
            criterionMatch,
            expectedVersion,
            reason,
            actorFromRequest(req),
            db
          )
        );
      }
      return errorResponse("Method not allowed", 405);
    }

    // --- Work items (planning layer) ---
    const workItemMatch = pathParam(path, /^\/api\/backlog\/items\/([^/]+)$/);
    if (workItemMatch) {
      if (method === "GET") {
        const item = getWorkItem(workItemMatch, db);
        if (!item) return errorResponse("Work item not found", 404);
        return jsonResponse(item);
      }
      if (method === "PATCH") {
        const body = await readJsonBody(req);
        const expectedVersion = optionalInt(
          body.expectedVersion,
          "expectedVersion",
          1,
          Number.MAX_SAFE_INTEGER
        );
        if (expectedVersion === undefined) {
          return errorResponse(`"expectedVersion" is required`);
        }

        const status =
          body.status === undefined
            ? undefined
            : (optionalEnum(body.status, "status", WORK_ITEM_STATUSES) as WorkItemStatus);
        const definition =
          body.definition === undefined
            ? undefined
            : (optionalEnum(
                body.definition,
                "definition",
                WORK_ITEM_DEFINITIONS
              ) as WorkItemDefinition);
        const priority =
          body.priority === undefined
            ? undefined
            : (optionalEnum(body.priority, "priority", WORK_ITEM_PRIORITIES) as WorkItemPriority);

        const updated = updateWorkItem(
          workItemMatch,
          expectedVersion,
          {
            title: body.title === undefined ? undefined : requireText(body.title, "title", 200),
            description: optionalText(body.description, "description", 20_000),
            status,
            definition,
            priority,
            position: optionalInt(body.position, "position", -100_000, 100_000),
            parentId:
              body.parentId === undefined
                ? undefined
                : body.parentId === null
                  ? null
                  : requireText(body.parentId, "parentId", 200),
          },
          actorFromRequest(req),
          db
        );
        return jsonResponse(updated);
      }
      if (method === "DELETE") {
        const body = await readJsonBody(req);
        const expectedVersion = optionalInt(
          body.expectedVersion,
          "expectedVersion",
          1,
          Number.MAX_SAFE_INTEGER
        );
        if (expectedVersion === undefined) {
          return errorResponse(`"expectedVersion" is required`);
        }
        const reason = requireText(body.reason, "reason", 500);
        const discarded = discardWorkItem(
          workItemMatch,
          expectedVersion,
          reason,
          actorFromRequest(req),
          db
        );
        return jsonResponse(discarded);
      }
      return errorResponse("Method not allowed", 405);
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
      const forceManual = body.forceManual === undefined ? false : Boolean(body.forceManual);
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
    if (err instanceof WorkItemConflictError) {
      return conflictResponse(err.message, err.current);
    }
    if (err instanceof WorkItemValidationError) {
      return errorResponse(err.message, 422);
    }
    if (err instanceof PlanValidationError) {
      return errorResponse(err.message, 422);
    }
    if (err instanceof TaskValidationError) {
      return errorResponse(err.message, 422);
    }

    // Technical detail stays in the server log; the client gets a generic error.
    console.error("API error:", err);
    return errorResponse("Internal server error", 500);
  }
}
