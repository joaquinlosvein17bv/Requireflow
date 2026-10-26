import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createProject } from "../src/domain/project.ts";
import { listTasks } from "../src/domain/task.ts";
import { listChanges } from "../src/domain/changelog.ts";
import {
  createIdea,
  createWorkItem,
  getBacklogTree,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  discardWorkItem,
  deriveTitle,
  WorkItemConflictError,
  WorkItemValidationError,
  type WorkItem,
} from "../src/domain/backlog/work-item.ts";

describe("Product backlog work items", () => {
  let db: Database;
  let projectId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    projectId = createProject({ name: "Cards" }, db).id;
  });

  afterEach(() => {
    db.close();
  });

  describe("idea capture", () => {
    it("stores an idea without creating executable tasks", () => {
      const { item } = createIdea({ projectId, text: "Permitir login con Google" }, db);

      expect(item.kind).toBe("idea");
      expect(item.status).toBe("captured");
      expect(item.definition).toBe("unspecified");
      expect(listTasks(projectId, {}, db)).toHaveLength(0);
      expect(listWorkItems(projectId, { kind: "idea" }, db)).toHaveLength(1);
    });

    it("preserves the original text verbatim and derives the title from the first line", () => {
      const text = "  Carrusel de cartas\n debe detenerse al salir\n y permitir volver con X  ";
      const { item } = createIdea({ projectId, text }, db);

      expect(item.original_text).toBe(text);
      expect(item.title).toBe("Carrusel de cartas");
    });

    it("derives a bounded title for a single long line", () => {
      const title = deriveTitle("a".repeat(300));
      expect(title.length).toBe(120);
      expect(title.endsWith("...")).toBe(true);
    });

    it("reports an obvious duplicate but still keeps the new capture", () => {
      const first = createIdea({ projectId, text: "Modo oscuro" }, db);
      const second = createIdea({ projectId, text: "  modo   OSCURO " }, db);

      expect(second.duplicateOf?.id).toBe(first.item.id);
      expect(second.item.id).not.toBe(first.item.id);
      expect(listWorkItems(projectId, { kind: "idea" }, db)).toHaveLength(2);
    });

    it("is idempotent when the caller repeats the same operation key", () => {
      const first = createIdea(
        { projectId, text: "Compartir carta por link", operationKey: "po-2026-10-26-1" },
        db
      );
      const second = createIdea(
        { projectId, text: "Compartir carta por link", operationKey: "po-2026-10-26-1" },
        db
      );

      expect(second.deduplicated).toBe(true);
      expect(second.item.id).toBe(first.item.id);
      expect(listWorkItems(projectId, { kind: "idea" }, db)).toHaveLength(1);
    });

    it("rejects empty text", () => {
      expect(() => createIdea({ projectId, text: "   " }, db)).toThrow(WorkItemValidationError);
    });

    it("records the capture in the append-only change log", () => {
      const { item } = createIdea({ projectId, text: "Notificaciones push" }, db);
      const changes = listChanges(projectId, 10, db);

      expect(changes).toHaveLength(1);
      expect(changes[0]?.action).toBe("idea.captured");
      expect(changes[0]?.entity_id).toBe(item.id);
    });
  });

  describe("versioning and state machine", () => {
    it("bumps the version on every update", () => {
      const { item } = createIdea({ projectId, text: "Reclamar carta" }, db);
      const updated = updateWorkItem(item.id, 1, { status: "draft" }, "user:test", db);

      expect(updated.version).toBe(2);
      expect(updated.status).toBe("draft");
    });

    it("rejects a stale expected version and exposes the current state", () => {
      const { item } = createIdea({ projectId, text: "Responder carta" }, db);
      updateWorkItem(item.id, 1, { status: "draft" }, "user:test", db);

      let conflict: unknown;
      try {
        updateWorkItem(item.id, 1, { status: "refined" }, "user:test", db);
      } catch (err) {
        conflict = err;
      }

      expect(conflict).toBeInstanceOf(WorkItemConflictError);
      expect((conflict as WorkItemConflictError).current.version).toBe(2);
    });

    it("rejects illegal definition transitions", () => {
      const { item } = createIdea({ projectId, text: "Ver conversaciones" }, db);
      expect(() =>
        updateWorkItem(item.id, 1, { status: "ready" }, "user:test", db)
      ).toThrow(WorkItemValidationError);
    });

    it("requires a reason to discard and keeps the row", () => {
      const { item } = createIdea({ projectId, text: "Idea descartable" }, db);

      expect(() => discardWorkItem(item.id, 1, "  ", "user:test", db)).toThrow(
        WorkItemValidationError
      );

      const discarded = discardWorkItem(item.id, 1, "Duplicada de otra idea", "user:test", db);
      expect(discarded.status).toBe("discarded");
      expect(discarded.discarded_at).not.toBeNull();
      expect(getWorkItem(item.id, db)).not.toBeNull();
      expect(listWorkItems(projectId, { kind: "idea" }, db)).toHaveLength(0);
      expect(listWorkItems(projectId, { kind: "idea", includeDiscarded: true }, db)).toHaveLength(1);
    });
  });

  describe("epics and stories", () => {
    it("assigns stable, non-recycled codes", () => {
      const epicA = createWorkItem({ projectId, kind: "epic", title: "Crear cartas" }, db);
      const epicB = createWorkItem({ projectId, kind: "epic", title: "Abrir cartas" }, db);
      const story = createWorkItem(
        { projectId, kind: "story", title: "Elegir imagen", parentId: epicA.id },
        db
      );

      expect(epicA.code).toBe("E01");
      expect(epicB.code).toBe("E02");
      expect(story.code).toBe("H001");
    });

    it("requires a story to belong to an epic of the same project", () => {
      const epic = createWorkItem({ projectId, kind: "epic", title: "Crear cartas" }, db);
      const otherProject = createProject({ name: "Other" }, db).id;
      const foreignEpic = createWorkItem(
        { projectId: otherProject, kind: "epic", title: "Ajeno" },
        db
      );

      expect(() =>
        createWorkItem({ projectId, kind: "story", title: "Sin padre" }, db)
      ).toThrow(WorkItemValidationError);

      expect(() =>
        createWorkItem(
          { projectId, kind: "story", title: "Padre ajeno", parentId: foreignEpic.id },
          db
        )
      ).toThrow(WorkItemValidationError);

      expect(() =>
        createWorkItem(
          { projectId, kind: "story", title: "Padre directo", parentId: epic.id },
          db
        )
      ).not.toThrow();
    });
  });

  describe("two views over one record", () => {
    it("returns the same story under its epic and in the flat list", () => {
      const epic = createWorkItem({ projectId, kind: "epic", title: "Crear cartas" }, db);
      const story = createWorkItem(
        { projectId, kind: "story", title: "Elegir imagen de portada", parentId: epic.id },
        db
      );
      createIdea({ projectId, text: "Carrusel con X" }, db);

      const tree = getBacklogTree(projectId, db);
      const byEpic = tree.epics[0]?.stories[0] as WorkItem;

      expect(tree.ideas).toHaveLength(1);
      expect(byEpic.id).toBe(story.id);
      expect(tree.stories[0]?.id).toBe(story.id);
      expect(tree.ungrouped).toHaveLength(0);
    });
  });
});
