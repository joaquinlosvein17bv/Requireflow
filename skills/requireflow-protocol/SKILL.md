---
name: requireflow-protocol
description: >
  Execution lifecycle discipline for AI agents using RequireFlow: project context,
  active database verification, task timing, history and safe archival, plus the
  product-mode guard that forbids implementing unapproved scope.
  Triggers: project detection or linkage, starting/completing execution tasks,
  cycle time, history search, "revisa RequireFlow y continúa con G01".
license: MIT
metadata:
  author: joaquinlosvein17bv
  version: "2.0.0"
---

# RequireFlow Agent Protocol — Execution

This skill owns **execution**: which project you are in, which database is active, how a task is timed, and how work records are closed. It does **not** own product intent.

Planning — ideas, epics, stories, groups G##, decisions, acceptance criteria, scope approval — belongs to the separate `product-backlog` skill. Never let both skills manage the same functional state.

---

## 0. Capability discovery first

Before acting, discover the tools this installation actually exposes. Do not assume a tool exists because a document or a previous session mentioned it.

- Project and execution tools: `rf_project_detect`, `rf_project_list`, `rf_project_add`, `rf_task_*`, `rf_history_search`, `rf_efficiency_stats`, `rf_archive_run`, `rf_workspace_classify`, `rf_project_set_mode`, `rf_backlog_tree`, `rf_idea_capture`.
- Planning and approval tools (groups, decisions, criteria, reviews) may be absent in an older installation.

If the task the user asks for needs a tool that is not registered, **stop and say so**. Never simulate persistence, never invent an ID, and never write product state into an execution table as a substitute.

Verify the active storage before writing anything:

```bash
requireflow db
```

It prints the active database path, its schema version, the V2 default, and the legacy v1 file. RequireFlow 2 refuses to open a v1 database on purpose: if you see that error, the user must export the legacy data (`requireflow legacy export`) instead of migrating it.

---

## 1. Project context and directory linkage (MANDATORY)

1. Call `rf_workspace_classify` (or `requireflow db` plus `rf_project_list`) before creating anything.
2. Distinguish the six situations: project linked, subfolder of a project, nested independent git repository, empty new folder, unregistered directory with code, generic location.
3. **Not registered is not the same as empty.** Never create a phantom project from the home directory, the desktop, a drive root or a temp folder.
4. Read the returned `situation`, `canInitialize` and `requiresConfirmation` and act on them:
   - `project-linked` / `project-subfolder`: continue in that project.
   - `empty-new` with an explicit user request: initialise idempotently.
   - `existing-unregistered` / `nested-independent-repo` / `ambiguous`: **ask the user** which project to use. Do not guess.
5. If the user names a `projectId` that does not exist, fail loudly. Never fall back to the current directory's project.

---

## 2. Mode check (MANDATORY before any write)

Read the project's `mode`.

### `legacy`

The classic task flow applies. Ideas that the user wants to keep for later still go to `rf_idea_capture`, not straight into tasks, unless the user explicitly asks for a task.

### `product`

Product mode changes the rules:

1. **Never call `rf_task_add` for product work.** Work enters through the planning layer.
2. Identify the target group (`G01`, `G02`, …) from the user's instruction, or the first group that is genuinely eligible by order and dependencies.
3. Read the group's canonical view **directly** from RequireFlow (CLI or MCP). Do not ask the user to paste a handoff document.
4. Before implementing, all of these must be true:
   - the group's definition is complete enough to be `ready`; and
   - its scope revision is **approved** by the human through the reliable channel the installation provides.
5. If a functional question is unanswered, **ask the user now**. Do not infer, do not record a placeholder, do not proceed.
6. If the scope is not approved, ask for approval through the human channel (dashboard or interactive CLI). A message from the user to you expresses intent; it is **not** the approval record. Never set `approved_by` to a human value yourself.
7. If the previous group is waiting for human review, do not skip it. Suggest it and stop.

When no group tooling is available in this installation, say plainly: *"Esta instalación todavía no expone las herramientas de grupo; no puedo ejecutar trabajo de producto sin un alcance aprobado."* Then stop. Do not fall back to the legacy task flow.

---

## 3. Task lifecycle (execution)

### Start before coding — MANDATORY

Call `rf_task_start(id)` at the moment you begin. It records `started_at` in UTC and begins the cycle measurement.

### Complete after verification — MANDATORY

After running the relevant checks, call `rf_task_complete(id, notes)`:

- `notes`: one or two sentences of technical summary, written into the searchable history.
- Completing an already completed task is a no-op; do not expect a second cycle.

**Completing a task never accepts a group.** A green test suite, an agent saying "done", or `rf_task_complete` are technical facts. Human acceptance of a product group is a different, human-owned event.

### Selecting work

Use `rf_task_next` (or `requireflow next`) and respect its answer:

- `nextTask`: eligible execution work.
- `blocked`: items that exist but are not eligible, each with a reason. **Report the reason; never work around it** by creating a new task, editing a story, or calling a start command directly.
- Nothing eligible: say so. Do not manufacture work to look productive.

Legacy tasks without a planning link keep working in `legacy` mode. In `product` mode they stay visible but must not bypass the approval gate.

---

## 4. Archival (explicit, never "to clean up")

- `requireflow archive` respects the project threshold.
- `--force` / `forceManual: true` flushes everything completed now. Use it **only** when the user asks to clean the board, and never while a group is waiting for human review: that review needs the completed work visible.
- Archiving moves a task to permanent history; it does not accept, approve, or close a group.

---

## 5. History and past work

Before fixing a bug or refactoring an existing area, call `rf_history_search(query)` with relevant keywords. History is the archived snapshot of completed work, not the product decision log. Decisions and scope live in the planning layer.

---

## 6. Handoff to and from `product-backlog`

- The user says "revisa RequireFlow y continúa con G01": this skill reads the group, confirms readiness and approval, and only then enters the normal ODD implementation procedure.
- ODD may create and maintain its own `odd/tasks/<feature>.md`, specs `S#`, tasks `T#`, tests and evidence. That is ODD's internal work. RequireFlow stores pointers and evidence, never a second editable copy of those tasks.
- Do not report every micro-task as an independent RequireFlow task. Link execution to the group only where it is useful for traceability.
- When implementation ends, report evidence and leave the group **pending human review**. Never mark it accepted.
- A defect found by the user reopens the same group for correction. A new capability is a scope change, not a defect: route it to `product-backlog`.

---

## 7. Delivery guarantee

Calling MCP tools is internal bookkeeping. It never replaces the user-facing answer.

- Execute the required calls first.
- End every turn with a complete, human-readable summary of what was done, what was verified and what is pending.
- A failed tool call must never crash the answer, and must never be reported as success.

---

## 8. Audit before answering

- Did I verify the project and the active database?
- Did I confuse an unregistered directory with a new product?
- In product mode, did I avoid creating tasks and avoid implementing unapproved scope?
- Did I ask the user instead of inventing a missing decision?
- Did I report blocked selection reasons instead of bypassing them?
- Did I keep acceptance human, and separate from tests and from `rf_task_complete`?
- Did I avoid archiving work that a human review still needs?
