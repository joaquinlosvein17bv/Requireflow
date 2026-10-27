import { Database } from "bun:sqlite";
import { getDatabase } from "../../db/connection.ts";
import type { Project } from "../project.ts";
import { getProject } from "../project.ts";
import type { Task } from "../task.ts";
import { getWorkItem } from "./work-item.ts";
import {
  currentScopeHash,
  listGroupsForStory,
  type Increment,
} from "./increment.ts";
import { PlanValidationError } from "./scope.ts";

/**
 * Single eligibility policy for every transport.
 *
 * Legacy projects keep the historical behaviour. Product projects only select
 * work whose story is refined and whose group is approved with the exact scope
 * the human approved. There is no second copy of this rule in CLI, MCP, HTTP or
 * the dashboard: they all call this module or the domain function that uses it.
 */
export interface TaskEligibility {
  eligible: boolean;
  reason: string | null;
  group: Increment | null;
}

function groupForStory(
  storyId: string,
  db: Database
): { group: Increment | null; reason: string | null } {
  const groups = listGroupsForStory(storyId, db);
  if (groups.length === 0) {
    return { group: null, reason: "the story does not belong to any group" };
  }

  for (const group of groups) {
    if (group.status === "aprobado" || group.status === "en_implementacion") {
      const hash = currentScopeHash(group.id, db);
      if (group.approved_scope_hash === hash) {
        return { group, reason: null };
      }
      return {
        group: null,
        reason: `group ${group.code} changed after approval: the scope must be approved again`,
      };
    }
  }

  return {
    group: null,
    reason: `the story belongs to groups that are not approved (${groups
      .map((group) => `${group.code}: ${group.status}`)
      .join(", ")})`,
  };
}

export function taskEligibility(
  task: Task,
  project: Project,
  db: Database = getDatabase()
): TaskEligibility {
  if (project.mode !== "product") {
    return { eligible: true, reason: null, group: null };
  }

  if (!task.work_item_id) {
    return {
      eligible: false,
      reason: "the task is not linked to a product story, and the project is in product mode",
      group: null,
    };
  }

  const story = getWorkItem(task.work_item_id, db);
  if (!story) {
    return { eligible: false, reason: "the linked story no longer exists", group: null };
  }
  if (story.kind !== "story") {
    return {
      eligible: false,
      reason: `the linked item is a ${story.kind}, not a story`,
      group: null,
    };
  }
  if (story.status !== "ready") {
    return {
      eligible: false,
      reason: `story ${story.code ?? story.id} is '${story.status}', not refined`,
      group: null,
    };
  }

  const resolved = groupForStory(story.id, db);
  if (!resolved.group) {
    return { eligible: false, reason: resolved.reason, group: null };
  }
  return { eligible: true, reason: null, group: resolved.group };
}

/** Guard used before a task starts or moves into progress. */
export function assertTaskCanStart(task: Task, db: Database = getDatabase()): void {
  const project = getProject(task.project_id, db);
  if (!project) {
    throw new PlanValidationError(`Project not found with ID: ${task.project_id}`);
  }
  const eligibility = taskEligibility(task, project, db);
  if (!eligibility.eligible) {
    throw new PlanValidationError(
      `Task "${task.title}" cannot start: ${eligibility.reason}. ` +
        `Approve the group scope, or refine the story, before executing product work.`
    );
  }
}

/**
 * Guard used when a task is created.
 *
 * In product mode a task must be linked to a story of an approved group; the
 * legacy "create a task for anything" path exists only in legacy projects.
 */
export function assertTaskCreationAllowed(
  project: Project,
  workItemId: string | null | undefined,
  db: Database = getDatabase()
): void {
  if (project.mode !== "product") return;

  if (!workItemId) {
    throw new PlanValidationError(
      `Project "${project.name}" is in product mode: a task must belong to a story of an approved group. ` +
        `Create or refine the story first and link the task to it.`
    );
  }

  const story = getWorkItem(workItemId, db);
  if (!story) {
    throw new PlanValidationError(`Work item not found with ID: ${workItemId}`);
  }
  if (story.kind !== "story") {
    throw new PlanValidationError(`Tasks can only be linked to stories; ${workItemId} is a ${story.kind}`);
  }
  if (story.project_id !== project.id) {
    throw new PlanValidationError(`Story ${workItemId} belongs to another project`);
  }
  if (story.status !== "ready") {
    throw new PlanValidationError(
      `Story ${story.code ?? story.id} is '${story.status}'. Refine it before creating execution tasks.`
    );
  }

  const resolved = groupForStory(story.id, db);
  if (!resolved.group) {
    throw new PlanValidationError(
      `Cannot create a task for story ${story.code ?? story.id}: ${resolved.reason}.`
    );
  }
}
