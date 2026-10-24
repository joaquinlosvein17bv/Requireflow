import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from "node:path";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import {
  resolveCurrentProject,
  getProject,
  getOrCreateProject,
  createProject,
  listProjects,
  detectProject,
} from "../domain/project.ts";
import {
  createTask,
  listTasks,
  getNextTask,
  startTask,
  completeTask,
  updateTask,
  type TaskType,
  type TaskPriority,
  type TaskStatus,
} from "../domain/task.ts";
import { archiveDoneTasks } from "../domain/archive.ts";
import { searchHistory } from "../domain/history.ts";
import { calculateProjectMetrics } from "../domain/efficiency.ts";

/**
 * Resolves the project a tool call targets.
 *
 * An explicitly supplied id must exist: silently falling back to the current
 * directory made an agent write into a different project than the one it named
 * (RF-02). Automatic resolution happens only when no id is supplied.
 */
function resolveProjectId(projectId?: string, db?: Database): string {
  if (projectId !== undefined && projectId !== null && projectId.trim() !== "") {
    const existing = getProject(projectId, db);
    if (!existing) {
      throw new Error(
        `Project not found with ID: ${projectId}. Run rf_project_list to list projects, or rf_project_detect to see which project owns the working directory.`
      );
    }
    return existing.id;
  }

  const current = resolveCurrentProject(process.cwd(), db);
  return current.id;
}

/**
 * Runs a tool body and normalizes its outcome into an MCP text result.
 * Kept non-generic so the SDK's `server.tool` overloads keep inferring the
 * argument shape from each tool's literal schema.
 */
async function runTool(name: string, action: () => unknown): Promise<CallToolResult> {
  try {
    const result = await action();
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error executing ${name}: ${message}`,
        },
      ],
    };
  }
}

export function registerMcpTools(server: McpServer, db: Database = getDatabase()): void {
  /**
   * Registers one tool under its primary name and an alias.
   * `register` receives each name so the literal schema stays at the call site
   * and the SDK can infer the argument types.
   */
  const registerDual = (
    primaryName: string,
    aliasName: string,
    description: string,
    register: (name: string, description: string) => void
  ): void => {
    register(primaryName, description);
    register(aliasName, `${description} (alias of ${primaryName})`);
  };

  // 1. rf_project_detect / project_current
  registerDual(
    "rf_project_detect",
    "project_current",
    "Detect the project that owns the working directory (read-only; never creates a project)",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          cwd: z.string().optional().describe("Working directory to detect project from"),
        },
        (args) =>
          runTool("rf_project_detect", () => {
            const targetCwd = args.cwd || process.cwd();
            const detection = detectProject(targetCwd, db);

            if (detection.project) {
              return {
                ...detection.project,
                is_directory_linked: true,
                detection_source: detection.source,
                detected_root: detection.rootPath,
              };
            }

            return {
              id: null,
              name: path.basename(detection.rootPath) || "default-project",
              root_path: detection.rootPath,
              root_key: detection.rootKey,
              is_directory_linked: false,
              detection_source: detection.source,
              detected_root: detection.rootPath,
            };
          })
      )
  );

  // 1b. rf_project_list / project_list
  registerDual(
    "rf_project_list",
    "project_list",
    "List all registered projects in RequireFlow with their IDs, names, root paths, and active task counts",
    (name, description) =>
      server.tool(name, description, {}, () =>
        runTool("rf_project_list", () => listProjects(db))
      )
  );

  // 1c. rf_project_add / project_create
  registerDual(
    "rf_project_add",
    "project_create",
    "Register a project explicitly. Returns the existing project when the root path is already registered.",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          name: z.string().min(1).describe("Display name for the project"),
          rootPath: z
            .string()
            .optional()
            .describe("Absolute repository root. Makes the registration idempotent."),
          description: z.string().optional().describe("Optional project description"),
          archiveThresholdHours: z
            .number()
            .optional()
            .describe("Hours a completed task waits before automatic archival"),
        },
        (args) =>
          runTool("rf_project_add", () => {
            if (args.rootPath) {
              return getOrCreateProject(args.name, args.rootPath, db);
            }
            return createProject(
              {
                name: args.name,
                description: args.description,
                archiveThresholdHours: args.archiveThresholdHours,
              },
              db
            );
          })
      )
  );

  // 2. rf_task_list / task_list
  registerDual(
    "rf_task_list",
    "task_list",
    "List tasks for a project with optional filters for status, section, priority, and type",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          status: z
            .enum(["backlog", "todo", "in_progress", "done", "archived"])
            .optional()
            .describe("Filter by task status"),
          sectionId: z.string().optional().describe("Filter by section ID"),
          priority: z
            .enum(["low", "medium", "high", "blocker"])
            .optional()
            .describe("Filter by priority"),
          type: z
            .enum(["feature", "fix", "bugfix", "chore", "refactor", "debt"])
            .optional()
            .describe("Filter by task type"),
        },
        (args) =>
          runTool("rf_task_list", () => {
            const pId = resolveProjectId(args.projectId, db);
            return listTasks(
              pId,
              {
                status: args.status as TaskStatus | undefined,
                sectionId: args.sectionId,
                priority: args.priority as TaskPriority | undefined,
                type: args.type as TaskType | undefined,
              },
              db
            );
          })
      )
  );

  // 3. rf_task_next / task_next
  registerDual(
    "rf_task_next",
    "task_next",
    "Get the single highest-priority pending task to work on next (blocker > high > medium > low)",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          sectionId: z.string().optional().describe("Optional section filter"),
        },
        (args) =>
          runTool("rf_task_next", () => {
            const pId = resolveProjectId(args.projectId, db);
            const task = getNextTask(pId, args.sectionId, db);
            return task || { message: "No pending tasks found in backlog/todo" };
          })
      )
  );

  // 4. rf_task_add / task_create
  registerDual(
    "rf_task_add",
    "task_create",
    "Add a new task, feature, chore, or bugfix to the project backlog",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          title: z.string().min(1).describe("Task title or headline"),
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          description: z.string().optional().describe("Detailed description or instructions"),
          sectionId: z.string().optional().describe("Target section ID"),
          type: z
            .enum(["feature", "fix", "bugfix", "chore", "refactor", "debt"])
            .optional()
            .default("feature")
            .describe("Type of task"),
          priority: z
            .enum(["low", "medium", "high", "blocker"])
            .optional()
            .default("medium")
            .describe("Priority level"),
          storyPoints: z.number().optional().describe("Estimated story points"),
          tags: z.union([z.array(z.string()), z.string()]).optional().describe("Tags"),
        },
        (args) =>
          runTool("rf_task_add", () => {
            const pId = resolveProjectId(args.projectId, db);
            return createTask(
              {
                projectId: pId,
                title: args.title,
                description: args.description,
                sectionId: args.sectionId,
                type: args.type as TaskType,
                priority: args.priority as TaskPriority,
                storyPoints: args.storyPoints,
                tags: args.tags,
              },
              db
            );
          })
      )
  );

  // 5. rf_task_start / task_start
  registerDual(
    "rf_task_start",
    "task_start",
    "Transition a task to in_progress and record the started_at timestamp",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          id: z.string().min(1).describe("Task ID to start"),
        },
        (args) =>
          runTool("rf_task_start", () => {
            const started = startTask(args.id, db);
            if (!started) {
              throw new Error(`Task not found with ID: ${args.id}`);
            }
            return started;
          })
      )
  );

  // 6. rf_task_complete / task_complete
  registerDual(
    "rf_task_complete",
    "task_complete",
    "Mark a task as completed (done), record completed_at timestamp, calculate cycle time, and save resolution notes",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          id: z.string().min(1).describe("Task ID to complete"),
          notes: z.string().optional().describe("Summary notes of the resolution or implementation"),
        },
        (args) =>
          runTool("rf_task_complete", () => {
            const completed = completeTask(args.id, args.notes, db);
            if (!completed) {
              throw new Error(`Task not found with ID: ${args.id}`);
            }
            return completed;
          })
      )
  );

  // 7. rf_task_update / task_update
  registerDual(
    "rf_task_update",
    "task_update",
    "Update task title, description, priority, type, section, or notes",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          id: z.string().min(1).describe("Task ID to update"),
          title: z.string().optional().describe("New title"),
          description: z.string().optional().describe("New description"),
          priority: z.enum(["low", "medium", "high", "blocker"]).optional().describe("New priority"),
          type: z.enum(["feature", "fix", "bugfix", "chore", "refactor", "debt"]).optional().describe("New type"),
          sectionId: z.string().optional().describe("New section ID"),
          status: z.enum(["backlog", "todo", "in_progress", "done", "archived"]).optional().describe("New status"),
          notes: z.string().optional().describe("Notes"),
          tags: z.union([z.array(z.string()), z.string()]).optional().describe("Tags"),
        },
        (args) =>
          runTool("rf_task_update", () => {
            const tagsStr = Array.isArray(args.tags) ? args.tags.join(",") : args.tags;
            const updated = updateTask(
              args.id,
              {
                title: args.title,
                description: args.description,
                priority: args.priority as TaskPriority | undefined,
                type: args.type as TaskType | undefined,
                section_id: args.sectionId,
                status: args.status as TaskStatus | undefined,
                notes: args.notes,
                tags: tagsStr,
              },
              db
            );
            if (!updated) {
              throw new Error(`Task not found with ID: ${args.id}`);
            }
            return updated;
          })
      )
  );

  // 8. rf_archive_run / task_archive_done
  registerDual(
    "rf_archive_run",
    "task_archive_done",
    "Flush all currently completed tasks from the active board into the permanent history archive",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          forceManual: z.boolean().optional().default(true).describe("Force immediate archive flush of all done tasks"),
          thresholdHours: z.number().optional().describe("Threshold in hours if not forcing manual flush"),
        },
        (args) =>
          runTool("rf_archive_run", () => {
            const pId = resolveProjectId(args.projectId, db);
            return archiveDoneTasks(pId, args.forceManual ?? true, args.thresholdHours, db);
          })
      )
  );

  // 9. rf_history_search / history_list
  registerDual(
    "rf_history_search",
    "history_list",
    "Search through permanent history archive using FTS5 full-text search across past work, resolutions, and notes",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          query: z.string().optional().describe("Search keywords or query"),
          limit: z.number().optional().default(20).describe("Maximum records to return"),
        },
        (args) =>
          runTool("rf_history_search", () => {
            const pId = resolveProjectId(args.projectId, db);
            return searchHistory(pId, args.query, args.limit ?? 20, db);
          })
      )
  );

  // 10. rf_efficiency_stats / efficiency_stats
  registerDual(
    "rf_efficiency_stats",
    "efficiency_stats",
    "Retrieve efficiency metrics including average cycle time, lead time, throughput, and bugfix velocity",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          timeWindowDays: z.number().optional().default(30).describe("Time window in days for metrics calculation"),
        },
        (args) =>
          runTool("rf_efficiency_stats", () => {
            const pId = resolveProjectId(args.projectId, db);
            return calculateProjectMetrics(pId, args.timeWindowDays ?? 30, db);
          })
      )
  );
}
