---
name: requireflow-protocol
description: >
  Task, backlog, and bugfix lifecycle discipline for AI agents using RequireFlow.
  Triggers: Project detection, task creation, starting tasks, completing tasks, cycle-time tracking, or searching history.
license: MIT
metadata:
  author: joaquinlosvein17bv
  version: "1.0.0"
---

# RequireFlow Agent Protocol

This skill guides AI coding assistants (Claude Code, Cursor, Cline, Antigravity, Windsurf) to autonomously track, start, and complete development tasks using **RequireFlow** MCP tools.

---

## 🎯 When to Use

Activate and follow this protocol when:
- The user asks to work on a new feature, bugfix, refactor, or chore.
- You are autonomous and looking for the next prioritized task to tackle.
- You are about to start writing or modifying code.
- You have completed work and verified tests.
- You need past context or want to check how a previous bug was resolved.

---

## ⚡ Proactive Lifecycle Protocol

### 1. Project Detection & Task Intake
- **Detect Project**: If `projectId` is unknown, invoke `rf_project_detect` to resolve the current workspace root.
- **Auto-create Tasks**: When the user requests a new feature or reports a bug that isn't yet tracked, call `rf_task_add`:
  - `title`: Concise description of the work.
  - `type`: `feature` | `fix` / `bugfix` | `chore` | `refactor` | `debt`.
  - `priority`: `blocker` | `high` | `medium` | `low`.
  - `description`: Steps to reproduce or key requirements.

### 2. Autonomous Task Pickup (`rf_task_next`)
- When the user says *"¿qué sigue?"*, *"haz la siguiente tarea"*, or when operating in autonomous loops:
  - Call `rf_task_next(projectId)` to retrieve the highest priority item (`blocker > high > medium > low`).

### 3. Before Writing Code (`rf_task_start`) — MANDATORY
- In the exact moment you begin working on a task, call `rf_task_start(id)`.
- **Why**: This locks `started_at` in UTC. RequireFlow uses this to calculate exact **Cycle Time** (duration of active implementation).

### 4. After Verification (`rf_task_complete`) — MANDATORY
- Once tests pass and implementation is verified, call `rf_task_complete(id, notes)`:
  - `notes`: A 1-2 sentence technical summary of the resolution (e.g. *"Added database index on user_id and eliminated N+1 query"*).
- **Why**: This locks `completed_at`, calculates duration in seconds/minutes, and stores the solution for future semantic retrieval.

### 5. Researching Past Work (`rf_history_search`)
- Before fixing a bug or refactoring an area, call `rf_history_search(query)` with relevant keywords.
- Past completed tasks and their resolution notes will be returned via FTS5 full-text search.

### 6. Archival Maintenance (`rf_archive_run`)
- If the "Done" column accumulates finished items or the user requests a clean board, call `rf_archive_run(forceManual: true)` to move completed items into the permanent history changelog.

---

## 🛡️ Delivery Guarantee

Calling MCP tools is **internal bookkeeping**. Saving or updating a task NEVER replaces delivering your final user-facing response.
- Execute the MCP tool call first.
- Deliver your complete, human-readable answer and summary in the final message of the turn.
- A failed MCP call must never crash or prevent answering the user.
