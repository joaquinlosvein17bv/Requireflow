# RequireFlow — Agent Installation, Setup & Lifecycle Protocol

> **Instructions for AI Coding Assistants (Claude Code, Cursor, Cline, Antigravity, Windsurf)**  
> Repository: `https://github.com/joaquinlosvein17bv/Requireflow`

---

## 🤖 Instructions for the Agent (Read This First)

If a user has shared this repository with you and instructed you to **install, configure, or use RequireFlow**, follow this guide step-by-step.

---

### Step 1: Verification & Prerequisites
1. Check if **Bun** is installed:
   ```bash
   bun --version
   ```
   *If not installed, prompt the user or install via `https://bun.sh` (`powershell -c "irm bun.sh/install.ps1 | iex"` on Windows, or `curl -fsSL https://bun.sh/install | bash` on macOS/Linux).*

---

### Step 2: Build & Global Binary Installation
1. If you are inside the repository:
   ```bash
   bun install
   bun run build
   ```
2. The standalone binary is produced in `dist/requireflow` (or `dist/requireflow.exe` on Windows).
3. To enable global execution from any terminal directory:
   - **Windows**: Copy `dist/requireflow.exe` to `~/.bun/bin/requireflow.exe` or any folder in the system `PATH`.
   - **macOS / Linux**: Copy `dist/requireflow` to `~/.bun/bin/requireflow` or `/usr/local/bin/requireflow` and run `chmod +x /usr/local/bin/requireflow`.
   - Or use `bun link` inside the repository.

---

### Step 3: Register MCP Server in User's AI Editor

Add the `requireflow` server configuration to the user's active client:

#### Option A: Cursor
In `.cursor/mcp.json` or Cursor Settings ➔ MCP:
```json
{
  "mcpServers": {
    "requireflow": {
      "command": "requireflow",
      "args": ["mcp"]
    }
  }
}
```

#### Option B: Claude Desktop
In Claude Desktop configuration (`%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
```json
{
  "mcpServers": {
    "requireflow": {
      "command": "requireflow",
      "args": ["mcp"]
    }
  }
}
```

#### Option C: Antigravity / Windsurf / Cline / Roo Code
In the workspace or global MCP settings:
```json
{
  "mcpServers": {
    "requireflow": {
      "command": "requireflow",
      "args": ["mcp"]
    }
  }
}
```
*(If running directly from Bun source instead of the compiled binary, use: `"command": "bun"`, `"args": ["run", "/ABSOLUTE_PATH/bin/requireflow.ts", "mcp"]`)*.

---

### Step 4: Mandatory Post-Installation Message to the User

Upon completing the installation and MCP registration, **you MUST provide this short, friendly explanation and tips to the user**:

> ### ⚡ ¡RequireFlow está instalado y listo!
> 
> **¿Cómo será nuestro flujo de trabajo a partir de ahora?**
> 1. **Tú trabajas normalmente**: Solo pídeme lo que necesitas (crear una funcionalidad, solucionar un bug o avanzar tareas).
> 2. **Yo registro y mido todo automáticamente**: Crearé la tarea en el backlog (`rf_task_add`), marcaré el inicio del cronómetro cuando empiece a programar (`rf_task_start`), y al verificar las pruebas la marcaré como completada (`rf_task_complete`) calculando el tiempo de ciclo exacto.
> 3. **Cero consumo en segundo plano**: El proceso MCP se apaga solo al cerrar el chat; no consume recursos ni memoria innecesaria en tu PC.
> 
> **💡 Tips rápidos:**
> - **Ver el Tablero Kanban**: Cuando quieras revisar visualmente el tablero, abre una terminal y ejecuta:  
>   `requireflow ui`  
>   *(Se abrirá en `http://localhost:4242`. Para apagarlo, solo presiona `Ctrl + C`).*
> - **Pedirme la siguiente tarea**: Puedes decirme *"¿Qué sigue?"* o *"Haz la siguiente tarea"* y tomaré automáticamente el ítem de mayor prioridad del backlog.
> - **Ver tus estadísticas**: Ejecuta `requireflow stats` en la terminal o míralo en la pestaña **Eficiencia** de la interfaz web.

---

## 🧭 Core Lifecycle Protocol for the Agent

When interacting with tasks in any repository where RequireFlow is active:

| Phase | Tool to Call | Purpose |
| :--- | :--- | :--- |
| **0. Project & Context Guard** | `rf_project_list` / `rf_project_detect` | **Mandatory**: Verify if `cwd` is linked to an existing project. If creating from scratch in a new folder, notify the user. If user asks for features but `cwd` is not linked, list existing projects and ask whether to add to an existing backlog or initialize a new one. |
| **1. Intake** | `rf_task_add` | Create backlog item with priority (`blocker`, `high`, `medium`, `low`) and type (`feature`, `bugfix`, `chore`, `refactor`). |
| **2. Autonomous Selection** | `rf_task_next` | Pull highest priority pending work (`blocker > high > medium > low`). |
| **3. Before Coding** | `rf_task_start` | **Mandatory**: Start task clock to record `started_at` in UTC. |
| **4. After Verification** | `rf_task_complete` | **Mandatory**: Record `completed_at`, compute cycle time, and log resolution notes. |
| **5. Investigation** | `rf_history_search` | Search FTS5 full-text changelog for past fixes and context. |
| **6. Board Cleanup** | `rf_archive_run` | Flush finished tasks from active Kanban to permanent History. |

---

## 🛠️ Complete MCP Tool Reference

1. `rf_project_detect`: Detects git repository or directory root, returning `is_directory_linked`.
2. `rf_project_list`: Lists all registered projects with active task counts and root paths.
3. `rf_task_list`: Lists tasks with filters (`status`, `sectionId`, `priority`, `type`).
4. `rf_task_next`: Fetches the highest priority pending item.
5. `rf_task_add`: Creates task in backlog.
6. `rf_task_start`: Starts task and timestamps `started_at`.
7. `rf_task_complete`: Completes task, timestamps `completed_at`, calculates duration, stores notes.
8. `rf_task_update`: Modifies title, priority, section, or notes.
9. `rf_archive_run`: Manually flushes completed items to permanent history.
10. `rf_history_search`: FTS5 semantic search in past work.
11. `rf_efficiency_stats`: Computes average cycle time, lead time, throughput, and bugfix velocity.
