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
  version: "2.2.0"
---

# RequireFlow Agent Protocol — Execution

This skill owns **execution**: which project you are in, which database is active, how a task is timed, and how work records are closed. It does **not** own product intent.

Planning — ideas, epics, stories, groups G##, decisions, acceptance criteria, scope approval — belongs to the separate `product-backlog` skill. Never let both skills manage the same functional state.

---

## 0. Capability discovery first

Before acting, discover the tools this installation actually exposes. Do not assume a tool exists because a document or a previous session mentioned it.

- Project and execution tools: `rf_project_detect`, `rf_project_list`, `rf_project_add`, `rf_task_*`, `rf_history_search`, `rf_efficiency_stats`, `rf_archive_run`, `rf_workspace_classify`, `rf_project_set_mode`, `rf_backlog_tree`, `rf_idea_capture`.
- Planning and approval tools: `rf_group_list`, `rf_group_get`, `rf_group_next`, `rf_group_propose`, `rf_group_refine`, `rf_work_item_create`, `rf_work_item_update`, `rf_idea_promote`, `rf_ac_add`, `rf_decision_record`, `rf_group_start`, `rf_group_evidence`, `rf_group_defect`, `rf_group_correction`.

If the task the user asks for needs a tool that is not registered, **stop and say so**. Never simulate persistence, never invent an ID, and never write product state into an execution table as a substitute.

Verify the active storage before writing anything:

```bash
requireflow db
```

It prints the active database path, its schema version, the V2 default, and the legacy v1 file. RequireFlow 2 refuses to open a v1 database on purpose: if you see that error, the user must export the legacy data (`requireflow legacy export`) instead of migrating it.

For `init`, use the V2 binary. `requireflow init --mode product` initializes the explicitly selected directory; when the folder lives inside an ancestor Git repository, `requireflow init --mode product --root .` confirms that folder explicitly. Never require `git init` as a workaround, and never accept a project registered at a different normalized root than the one requested.

---

## 1. Project context and directory linkage (MANDATORY)

1. Call `rf_workspace_classify` (or `requireflow db` plus `rf_project_list`) before creating anything.
2. Distinguish the six situations: project linked, subfolder of a project, nested independent git repository, empty new folder, unregistered directory with code, generic location.
3. **Not registered is not the same as empty.** Never create a phantom project from the home directory, the desktop, a drive root or a temp folder.
4. Read the returned `situation`, `canInitialize` and `requiresConfirmation` and act on them:
   - `project-linked` / `project-subfolder`: continue in that project.
   - `empty-new` with an explicit user request: initialise idempotently **at that directory**.
   - `existing-unregistered` / `nested-independent-repo` / `ambiguous`: **ask the user** which project to use, or require an explicit `--root`. Do not guess.
5. If the user names a `projectId` that does not exist, fail loudly. Never fall back to the current directory's project.

---

## 2. Mode check (MANDATORY before any write)

Read the project's `mode`.

### `legacy`

The classic task flow applies. Ideas that the user wants to keep for later still go to `rf_idea_capture`, not straight into tasks, unless the user explicitly asks for a task.

### `product`

Product mode changes the rules:

1. **Never use `rf_task_add` to capture ideas, create functional stories, or bypass an approval.** A functional story is not a technical task.
2. Resolve the target group: the one the user named (`G01`, `G02`, …) or `rf_group_next` when they say "the next one". `rf_group_next` never skips a group waiting for human review; if it reports `blocked`, report the blocker and stop.
3. Read the canonical view with `rf_group_get`. It returns goal, stories, dependencies, confirmed decisions, acceptance criteria, approved revision, `drifted`, `canExecute`, `readiness.blockers` and `nextAction`. This **is** the handoff: do not ask the user to paste a document and do not generate a manual handoff package.
4. Interpret `nextAction`:
   - `refine` → the group still needs work. Read `readiness.blockers`, ask the user only what is missing (one to three questions per round) and refine with `rf_group_refine` / `rf_ac_add` / `rf_work_item_update`.
   - `request_approval` → the scope is not approved, or it drifted after approval. Ask the user to approve in the dashboard or an interactive terminal. You cannot do it: there is no MCP approval tool.
   - `implement` → approved and current. Continue with step 6.
   - `await_review` → the group is waiting for the user's test. Do not implement it again automatically.
   - `fix` → a defect was reported. Correct it and deliver with `rf_group_correction`.
   - `done` / `blocked` → report and stop.
5. If any functional decision is missing, **ask the user now**. Never record `[NO ESPECIFICADO]`, `TODO` or an invented default; the server rejects placeholders. Do not turn a future group's decision into a blocker for the current group; explain the dependency only if it truly affects current behavior.
6. Start implementation with `rf_group_start`, then register technical execution units with `rf_task_add(workItemId: ...)` **only when** all of these hold:
   - the task is linked to a valid story;
   - the story belongs to an authorized group;
   - the approved revision is current;
   - the domain confirms the task is eligible (`taskEligibility` / `canExecute`);
   - the task does not duplicate ODD's internal `T#` list.
   One task per meaningful unit, not one per micro-step.
7. Do the technical work with ODD as usual: explore, plan, implement, test.
8. When implementation is technically complete, report evidence with `rf_group_evidence`. The group moves to `pendiente_revision_humana`. **This is not acceptance.**
9. If the user reports a failure, record it with `rf_group_defect` (optionally naming the failed criterion). The group returns to `en_correcciones`; fix it and call `rf_group_correction`. Repeat until the user accepts.
10. Never accept. Acceptance happens only in the dashboard or an interactive terminal, and only after the user tests the result.

When no group tooling is available in this installation, say plainly: *"Esta instalación todavía no expone las herramientas de grupo; no puedo ejecutar trabajo de producto sin un alcance aprobado."* Then stop. Do not fall back to the legacy task flow.

### 2.1 Provisional groups in product mode

All known groups are visible from the initial planning, including future provisional ones. Their existence is not permission to execute them and does not require answering all their questions before the current group.

- A group in `planificado` or `en_refinamiento` is provisional: it may have partial membership, `draft` stories or no criteria yet.
- `canExecute` is false and `nextAction` is `refine`.
- Do not call `rf_group_start` and do not create execution tasks for it.
- Do not force the user to refine G02–G04 while G01 is the increment being validated. Ask only the decisions that block the current increment; defer the rest.

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

### Eligibility rules that must not be bypassed

In product mode a task is eligible only when:

1. it is linked to a story (`workItemId`);
2. the story is `ready`;
3. the story belongs to a group whose status is `aprobado` or `en_implementacion`;
4. the approved scope hash matches the current scope (no drift).

A task without a story, a story in `draft`/`refined`, or a group not approved must be rejected. Do not use legacy tasks, direct SQL, or a new task to evade this rule.

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

- The user says "revisa RequireFlow y continúa con G01": this skill reads the group with `rf_group_get`, confirms readiness and approval, and only then enters the normal ODD implementation procedure.
- There is **no manual handoff package**. The canonical fields returned by `rf_group_get` are the handoff. Do not ask the user to paste a document, do not generate a copy, and do not require a separate file.
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
- Did I initialize the explicitly selected folder and verify the registered normalized root? Did I avoid a phantom project at an ancestor Git root?
- In product mode, did I avoid creating functional stories or capturing ideas with `rf_task_add`, and did I avoid implementing unapproved scope?
- Did I read the group with `rf_group_get` instead of asking for a manual handoff document?
- Did I respect `canExecute`, `nextAction`, `drifted`, dependencies and blockers?
- Did I ask the user instead of inventing a missing decision?
- Did I report blocked selection reasons instead of bypassing them?
- Did I keep acceptance human, and separate from tests and from `rf_task_complete`?
- Did I avoid archiving work that a human review still needs?
