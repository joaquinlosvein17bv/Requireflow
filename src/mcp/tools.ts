import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from "node:path";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import {
  getProject,
  getOrCreateProject,
  createProject,
  listProjects,
  detectProject,
  classifyWorkspace,
  setProjectMode,
  isProjectMode,
} from "../domain/project.ts";
import {
  createTask,
  listTasks,
  getNextTaskDecision,
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
import {
  createIdea,
  createWorkItem,
  getBacklogTree,
  promoteIdeaToStory,
  updateWorkItem,
  WorkItemConflictError,
} from "../domain/backlog/work-item.ts";
import {
  addAcceptanceCriterion,
  recordDecision,
  resolveAcceptanceCriterion,
  retireAcceptanceCriterion,
  supersedeAcceptanceCriterion,
} from "../domain/backlog/criteria.ts";
import {
  getIncrementView,
  listIncrements,
  nextIncrement,
  proposeGroups,
  refineIncrement,
  resolveIncrement,
} from "../domain/backlog/increment.ts";
import {
  deliverCorrection,
  getIncrementReviews,
  reportDefect,
  startImplementation,
  submitImplementationEvidence,
} from "../domain/backlog/review.ts";

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

  const detection = detectProject(process.cwd(), db);
  if (!detection.project) {
    throw new Error(
      `No project is registered for the working directory "${process.cwd()}". ` +
        `Run rf_project_detect and rf_project_add first, or pass projectId explicitly.`
    );
  }
  return detection.project.id;
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
    const detail =
      err instanceof WorkItemConflictError
        ? `\nCurrent state:\n${JSON.stringify(err.current, null, 2)}`
        : "";
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Error executing ${name}: ${message}${detail}`,
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

  // 1d. rf_workspace_classify / workspace_classify
  registerDual(
    "rf_workspace_classify",
    "workspace_classify",
    "Classify the working directory (linked, subfolder, nested repo, empty or unregistered) without creating anything",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          cwd: z.string().optional().describe("Directory to classify (defaults to the process cwd)"),
        },
        (args) =>
          runTool("rf_workspace_classify", () =>
            classifyWorkspace(args.cwd || process.cwd(), db)
          )
      )
  );

  // 1e. rf_project_set_mode / project_set_mode
  registerDual(
    "rf_project_set_mode",
    "project_set_mode",
    "Switch a project between the legacy task workflow and the product backlog mode",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          mode: z.enum(["legacy", "product"]).describe("Target project mode"),
        },
        (args) =>
          runTool("rf_project_set_mode", () => {
            if (!isProjectMode(args.mode)) {
              throw new Error(`Invalid mode "${String(args.mode)}". Allowed: legacy, product.`);
            }
            const pId = resolveProjectId(args.projectId, db);
            const updated = setProjectMode(pId, args.mode, "agent:mcp", db);
            if (!updated) throw new Error(`Project not found with ID: ${pId}`);
            return updated;
          })
      )
  );

  // 1f. rf_idea_capture / idea_capture
  registerDual(
    "rf_idea_capture",
    "idea_capture",
    "Capture a raw idea in seconds without converting it into executable work",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          text: z.string().min(1).describe("The idea exactly as the user expressed it"),
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          title: z.string().optional().describe("Optional short headline; derived from the text otherwise"),
          operationKey: z
            .string()
            .optional()
            .describe("Idempotency key: repeating the same key returns the same idea"),
        },
        (args) =>
          runTool("rf_idea_capture", () => {
            const pId = resolveProjectId(args.projectId, db);
            const result = createIdea(
              {
                projectId: pId,
                text: args.text,
                title: args.title,
                operationKey: args.operationKey,
                actor: "agent:mcp",
              },
              db
            );
            return {
              item: result.item,
              duplicate_of: result.duplicateOf?.id ?? null,
              deduplicated: result.deduplicated,
            };
          })
      )
  );

  // 1g. rf_backlog_tree / backlog_tree
  registerDual(
    "rf_backlog_tree",
    "backlog_tree",
    "Read the whole planning picture: ideas, epics with their stories, and ungrouped stories",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
        },
        (args) =>
          runTool("rf_backlog_tree", () => {
            const pId = resolveProjectId(args.projectId, db);
            return getBacklogTree(pId, db);
          })
      )
  );

  // 1h. rf_work_item_create / work_item_create
  registerDual(
    "rf_work_item_create",
    "work_item_create",
    "Create an epic or a story. Stories need an epic of the same project and a confirmed description",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          kind: z.enum(["epic", "story"]),
          title: z.string().min(1),
          projectId: z.string().optional(),
          description: z.string().optional().describe("Confirmed description; placeholders are rejected"),
          parentId: z.string().optional().describe("Epic ID for stories"),
          priority: z.enum(["low", "medium", "high", "blocker"]).optional(),
          status: z.enum(["captured", "draft", "refined", "ready", "discarded"]).optional(),
        },
        (args) =>
          runTool("rf_work_item_create", () => {
            const pId = resolveProjectId(args.projectId, db);
            return createWorkItem(
              {
                projectId: pId,
                kind: args.kind,
                title: args.title,
                description: args.description,
                parentId: args.parentId,
                priority: args.priority,
                status: args.status,
                actor: "agent:mcp",
              },
              db
            );
          })
      )
  );

  // 1i. rf_work_item_update / work_item_update
  registerDual(
    "rf_work_item_update",
    "work_item_update",
    "Refine a story or epic with optimistic concurrency: expectedVersion is required and a stale version conflicts",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          id: z.string().min(1),
          expectedVersion: z.number().int().positive(),
          title: z.string().optional(),
          description: z.string().optional(),
          status: z.enum(["captured", "draft", "refined", "ready", "discarded"]).optional(),
          definition: z.enum(["clear", "partial", "unspecified", "deferred", "delegated"]).optional(),
          priority: z.enum(["low", "medium", "high", "blocker"]).optional(),
          parentId: z.string().nullable().optional(),
        },
        (args) =>
          runTool("rf_work_item_update", () =>
            updateWorkItem(
              args.id,
              args.expectedVersion,
              {
                title: args.title,
                description: args.description,
                status: args.status,
                definition: args.definition,
                priority: args.priority,
                parentId: args.parentId,
              },
              "agent:mcp",
              db
            )
          )
      )
  );

  // 1j. rf_group_list / group_list
  registerDual(
    "rf_group_list",
    "group_list",
    "List the product groups (G01, G02, ...) with status, revision, drift and next action",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
        },
        (args) =>
          runTool("rf_group_list", () => {
            const pId = resolveProjectId(args.projectId, db);
            return listIncrements(pId, db).map((group) => {
              const view = getIncrementView(group.id, db);
              return {
                id: group.id,
                code: group.code,
                name: group.name,
                status: group.status,
                position: group.position,
                version: group.version,
                stories: view.stories.length,
                criteria: view.acceptanceCriteria.length,
                approvedRevision: group.approved_revision,
                drifted: view.drifted,
                canExecute: view.canExecute,
                nextAction: view.nextAction,
              };
            });
          })
      )
  );

  // 1i. rf_group_get / group_get
  registerDual(
    "rf_group_get",
    "group_get",
    "Read the canonical view of a group: goal, stories, dependencies, confirmed decisions, acceptance criteria, approval revision, drift and next action. Use this to start work on G01 directly",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1).describe("Group code (G01) or ID"),
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
        },
        (args) =>
          runTool("rf_group_get", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            const view = getIncrementView(group.id, db);
            return {
              ...view,
              exclusiones: group.exclusiones,
              approvedRevision: group.approved_revision,
              approvedAt: group.approved_at,
              approvedBy: group.approved_by,
              reviews: getIncrementReviews(group.id, db),
            };
          })
      )
  );

  // 1j. rf_group_next / group_next
  registerDual(
    "rf_group_next",
    "group_next",
    "Return the next group that still needs work, with its blocking reasons. Never skips a group waiting for human review",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
        },
        (args) =>
          runTool("rf_group_next", () => {
            const pId = resolveProjectId(args.projectId, db);
            const next = nextIncrement(pId, db);
            if (!next) return { group: null, message: "All groups are accepted" };
            return {
              group: getIncrementView(next.increment.id, db),
              blocked: next.blocked,
              blockers: next.blockers,
            };
          })
      )
  );

  // 1k. rf_group_propose / group_propose
  registerDual(
    "rf_group_propose",
    "group_propose",
    "Persist a whole set of proposed experience groups atomically. The proposal comes from the product analysis, never from a fixed rule",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          projectId: z.string().optional().describe("Project ID (defaults to current project)"),
          groups: z
            .array(
              z.object({
                code: z.string().describe("G01, G02, ..."),
                name: z.string().optional(),
                goal: z.string().optional().describe("Confirmed goal; no placeholders"),
                exclusiones: z.string().optional(),
                storyIds: z.array(z.string()).optional(),
                acceptanceCriteria: z.array(z.string()).optional().describe("Confirmed criteria"),
                dependsOn: z.array(z.string()).optional().describe("Group codes"),
              })
            )
            .min(1),
        },
        (args) =>
          runTool("rf_group_propose", () => {
            const pId = resolveProjectId(args.projectId, db);
            return proposeGroups(pId, args.groups, "agent:mcp", db);
          })
      )
  );

  // 1l. rf_group_refine / group_refine
  registerDual(
    "rf_group_refine",
    "group_refine",
    "Refine a group in one versioned step: goal, stories to add or remove, dependencies. Refuses edits outside the planning stages",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1).describe("Group code or ID"),
          expectedVersion: z.number().int().positive().describe("Version read from rf_group_get"),
          projectId: z.string().optional(),
          name: z.string().optional(),
          goal: z.string().optional(),
          exclusiones: z.string().optional(),
          addStoryIds: z.array(z.string()).optional(),
          removeStoryIds: z.array(z.string()).optional(),
          addDependencyCodes: z.array(z.string()).optional(),
          status: z
            .enum([
              "planificado",
              "en_refinamiento",
              "listo_para_aprobacion",
              "aprobado",
              "en_implementacion",
              "pendiente_revision_humana",
              "en_correcciones",
              "aceptado",
              "bloqueado",
            ])
            .optional()
            .describe("Legal transition only; agents can prepare a group for approval but cannot approve it"),
        },
        (args) =>
          runTool("rf_group_refine", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            return refineIncrement(
              group.id,
              args.expectedVersion,
              {
                name: args.name,
                goal: args.goal,
                exclusiones: args.exclusiones,
                addStoryIds: args.addStoryIds,
                removeStoryIds: args.removeStoryIds,
                addDependencyCodes: args.addDependencyCodes,
                status: args.status,
              },
              "agent:mcp",
              db
            );
          })
      )
  );

  // 1m. rf_ac_add / ac_add
  registerDual(
    "rf_ac_add",
    "ac_add",
    "Add a confirmed acceptance criterion with a stable AC-<group>-### code",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1).describe("Group code or ID"),
          text: z.string().min(1).describe("Confirmed, observable criterion"),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_ac_add", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            return addAcceptanceCriterion(
              { incrementId: group.id, text: args.text, actor: "agent:mcp" },
              db
            );
          })
      )
  );

  // 1m2. rf_ac_supersede / ac_supersede
  registerDual(
    "rf_ac_supersede",
    "ac_supersede",
    "Replace a criterion with corrected text. The old criterion stays as superseded history and the replacement gets a new AC code",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          criterion: z.string().min(1).describe("Criterion code (AC-G01-005) or id"),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .describe("Version read from rf_group_get; rejects a stale replacement"),
          text: z.string().min(1).describe("Corrected, confirmed criterion"),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_ac_supersede", () => {
            const pId = resolveProjectId(args.projectId, db);
            const current = resolveAcceptanceCriterion(pId, args.criterion, db);
            const replacement = supersedeAcceptanceCriterion(
              current.id,
              args.expectedVersion,
              args.text,
              "agent:mcp",
              db
            );
            return {
              superseded: resolveAcceptanceCriterion(pId, current.id, db),
              replacement,
            };
          })
      )
  );

  // 1m3. rf_ac_retire / ac_retire
  registerDual(
    "rf_ac_retire",
    "ac_retire",
    "Retire a criterion with a confirmed reason. It stays in the history and stops counting as active scope",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          criterion: z.string().min(1).describe("Criterion code (AC-G01-005) or id"),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .describe("Version read from rf_group_get; rejects a stale retirement"),
          reason: z.string().min(1).describe("Confirmed reason for retiring the criterion"),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_ac_retire", () => {
            const pId = resolveProjectId(args.projectId, db);
            const current = resolveAcceptanceCriterion(pId, args.criterion, db);
            const retired = retireAcceptanceCriterion(
              current.id,
              args.expectedVersion,
              args.reason,
              "agent:mcp",
              db
            );
            return { retired };
          })
      )
  );

  // 1n. rf_decision_record / decision_record
  registerDual(
    "rf_decision_record",
    "decision_record",
    "Record a decision the user actually answered. Placeholders are rejected: ask first, then persist",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          title: z.string().min(1),
          question: z.string().min(1).describe("The question that was asked"),
          answer: z.string().min(1).describe("The user's confirmed answer"),
          projectId: z.string().optional(),
          group: z.string().optional().describe("Group code or ID the decision applies to"),
          alternatives: z.string().optional(),
          impact: z.string().optional(),
        },
        (args) =>
          runTool("rf_decision_record", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = args.group ? resolveIncrement(pId, args.group, db) : null;
            if (args.group && !group) throw new Error(`Group not found: ${args.group}`);
            return recordDecision(
              {
                projectId: pId,
                incrementId: group?.id,
                title: args.title,
                question: args.question,
                answer: args.answer,
                alternatives: args.alternatives,
                impact: args.impact,
                actor: "agent:mcp",
              },
              db
            );
          })
      )
  );

  // 1o. rf_idea_promote / idea_promote
  registerDual(
    "rf_idea_promote",
    "idea_promote",
    "Turn a captured idea into a story once its description is confirmed. Refuses placeholders",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          ideaId: z.string().min(1),
          epicId: z.string().min(1),
          title: z.string().optional(),
          description: z.string().optional().describe("Confirmed description"),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_idea_promote", () =>
            promoteIdeaToStory(
              {
                ideaId: args.ideaId,
                epicId: args.epicId,
                title: args.title,
                description: args.description,
                actor: "agent:mcp",
              },
              db
            )
          )
      )
  );

  // 1p. rf_group_start / group_start
  registerDual(
    "rf_group_start",
    "group_start",
    "Move an approved, non-drifted group into implementation",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_group_start", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            return startImplementation(group.id, "agent:odd", db);
          })
      )
  );

  // 1q. rf_group_evidence / group_evidence
  registerDual(
    "rf_group_evidence",
    "group_evidence",
    "Report that implementation is technically complete and hand the group to human review. It never accepts the group",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1),
          evidence: z.string().min(1).describe("Checks run and observed results"),
          notes: z.string().optional(),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_group_evidence", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            return submitImplementationEvidence(
              {
                incrementId: group.id,
                actor: "agent:odd",
                evidence: args.evidence,
                notes: args.notes,
              },
              db
            );
          })
      )
  );

  // 1r. rf_group_defect / group_defect
  registerDual(
    "rf_group_defect",
    "group_defect",
    "Record a user-reported defect against a pending review and reopen the same group for correction",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1),
          description: z.string().min(1).describe("What the user observed"),
          acceptanceCriterionCode: z.string().optional(),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_group_defect", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            return reportDefect(
              {
                incrementId: group.id,
                actor: "agent:mcp",
                description: args.description,
                acceptanceCriterionCode: args.acceptanceCriterionCode,
              },
              db
            );
          })
      )
  );

  // 1s. rf_group_correction / group_correction
  registerDual(
    "rf_group_correction",
    "group_correction",
    "Deliver the correction for a defect and send the same group back to human review",
    (name, description) =>
      server.tool(
        name,
        description,
        {
          group: z.string().min(1),
          evidence: z.string().min(1),
          findingIds: z
            .array(z.string().min(1))
            .optional()
            .describe(
              "IDs of the findings this correction actually addresses. Omit them when there is no verifiable association: nothing is marked as corrected by default"
            ),
          projectId: z.string().optional(),
        },
        (args) =>
          runTool("rf_group_correction", () => {
            const pId = resolveProjectId(args.projectId, db);
            const group = resolveIncrement(pId, args.group, db);
            if (!group) throw new Error(`Group not found: ${args.group}`);
            return deliverCorrection(
              {
                incrementId: group.id,
                actor: "agent:odd",
                evidence: args.evidence,
                findingIds: args.findingIds,
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
            const decision = getNextTaskDecision(pId, args.sectionId, db);
            return {
              nextTask: decision.nextTask,
              blocked: decision.blocked,
              message: decision.nextTask
                ? null
                : decision.blocked.length > 0
                  ? "No eligible task: every candidate is blocked. Report the reasons; do not create work to bypass them."
                  : "No pending tasks found in backlog/todo",
            };
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
          workItemId: z
            .string()
            .optional()
            .describe("Story ID this task implements. Required in product mode"),
          oddTaskRef: z
            .string()
            .optional()
            .describe("Optional ODD task reference (e.g. T2) for traceability"),
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
                workItemId: args.workItemId,
                oddTaskRef: args.oddTaskRef,
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
          forceManual: z.boolean().optional().describe("Force immediate archive flush of all done tasks"),
          thresholdHours: z.number().optional().describe("Threshold in hours if not forcing manual flush"),
        },
        (args) =>
          runTool("rf_archive_run", () => {
            const pId = resolveProjectId(args.projectId, db);
            return archiveDoneTasks(pId, args.forceManual ?? false, args.thresholdHours, db);
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
