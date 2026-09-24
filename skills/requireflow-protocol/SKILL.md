---
name: requireflow-protocol
description: >
  Task, backlog, project context verification, and bugfix lifecycle discipline for AI agents using RequireFlow.
  Triggers: Project detection, directory linkage check, task creation, starting tasks, completing tasks, cycle-time tracking, or searching history.
license: MIT
metadata:
  author: joaquinlosvein17bv
  version: "1.1.0"
---

# RequireFlow Agent Protocol

This skill guides AI coding assistants (Claude Code, Cursor, Cline, Antigravity, Windsurf) to autonomously verify project context, link directories, track backlogs, and measure development cycle time using **RequireFlow** MCP tools.

---

## 🎯 When to Use

Activate and follow this protocol when:
- The user asks to create a new project, start from scratch, or initialize a repository.
- The user asks to add features, bugfixes, chores, or ideas to a backlog.
- The user asks *"¿qué sigue?"* or to execute pending tasks.
- You are about to write, modify, or verify code.
- You need to search past solutions or clean up the active Kanban board.

---

## 🧭 Project Context & Directory Linkage Verification (MANDATORY)

Before creating tasks or executing work, **always verify if the current execution directory (`cwd`) is linked to an existing RequireFlow project**:

1. Call `rf_project_list` and `rf_project_detect`.
2. Inspect the returned projects and check if the current directory matches any registered `root_path`.

### 🚨 Branch 1: Starting a Project from Scratch
If the current directory is new, empty, or does not match any registered project, AND the user is starting a project from scratch:
- **Notify the user explicitly**:
  > *"Detecto que este directorio (`<ruta_actual>`) no está vinculado a ningún proyecto en RequireFlow. Procederé a inicializar un proyecto nuevo desde cero llamado **`<nombre_directorio>`** para gestionar su backlog de forma independiente."*
- Ensure the project and default sections (`General`, `Frontend`, `Backend`, `Bugfixes`) are initialized before adding tasks.

### 🚨 Branch 2: Features Requested but Directory Not Linked (Ambiguous Context)
If the user requests features, bugfixes, or backlog items, but the current working directory is generic (e.g. desktop/home) or NOT linked to the intended project:
- **DO NOT create a phantom project blindly.**
- Call `rf_project_list` to fetch all registered projects.
- **List the existing projects to the user and ask for confirmation**:
  > *"El directorio actual (`<ruta_actual>`) no está vinculado a ningún proyecto registrado en RequireFlow.*  
  > *Tus proyectos actuales son:*  
  > *1. **`<Proyecto 1>`** (ID: `...`)*  
  > *2. **`<Proyecto 2>`** (ID: `...`)*  
  > *¿Deseas agregar esta(s) feature(s) al backlog de uno de estos proyectos existentes, o prefieres inicializar un proyecto nuevo para esta carpeta?"*
- Once the user answers or selects a project, assign the tasks to the chosen `projectId`.

### 🚨 Branch 3: Directory Already Linked
If the current directory matches a registered project:
- Work directly within that project's backlog without unnecessary questions.

---

## ⚡ Task Lifecycle Protocol

### 1. Task Intake (`rf_task_add`)
- Capture ideas quickly without losing focus:
  - `title`: Actionable headline.
  - `type`: `feature` | `fix` / `bugfix` | `chore` | `refactor` | `debt`.
  - `priority`: `blocker` | `high` | `medium` | `low`.
  - `sectionId`: Group by thematic section (`Frontend`, `Backend`, `Database`, `Auth`, etc.).
  - `storyPoints`: Complexity estimate (1, 2, 3, 5, 8...).

### 2. Autonomous Task Selection (`rf_task_next`)
- When asked *"¿qué sigue?"* or *"haz la siguiente tarea"*:
  - Call `rf_task_next(projectId)` to pull the single highest-priority pending item (`blocker > high > medium > low`).

### 3. Before Writing Code (`rf_task_start`) — MANDATORY
- At the exact moment you begin coding, call `rf_task_start(id)`.
- **Purpose**: Timestamps `started_at` in UTC. This begins the exact **Cycle Time** measurement.

### 4. After Verification (`rf_task_complete`) — MANDATORY
- After running tests and confirming the code works, call `rf_task_complete(id, notes)`:
  - `notes`: 1-2 sentence technical summary explaining how the task was solved or implemented.
- **Purpose**: Timestamps `completed_at`, calculates duration, and saves notes into the FTS5 searchable history.

### 5. Investigating Past Work (`rf_history_search`)
- Before solving a bug or refactoring an existing system, query `rf_history_search(query)` with relevant keywords to recover past context and previous fix details.

### 6. Archiving Done Items (`rf_archive_run`)
- If the "Done" column has accumulated completed cards or the user asks to clean up the board, run `rf_archive_run(forceManual: true)` to move them to the permanent audit history.

---

## 🛡️ Delivery Guarantee

Calling MCP tools is **internal bookkeeping**. Saving or updating a task NEVER replaces delivering your final user-facing response.
- Execute required MCP calls first.
- End every turn with a complete, human-readable response summarizing what was done.
- A failed MCP call must never crash or prevent answering the user.
