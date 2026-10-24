# RequireFlow ⚡

> **De la idea rápida a la ejecución real, sin perder el foco.**  
> *Local-first Backlog, Task & Bugfix Lifecycle Engine with Embedded Vanilla Dashboard and Agentic MCP Protocol.*

---

## 💡 Filosofía: ¿Por qué existe RequireFlow?

### El Dilema del Desarrollador: Ideas Rápidas vs. Pérdida de Foco
Mientras estás programando concentrado en una funcionalidad, tu mente genera ideas constantemente:
- *"Deberíamos meterle caché con Redis a esta consulta."*
- *"Hay que ajustar el espaciado de este botón en mobile."*
- *"Para la próxima versión hay que soportar autenticación con Google."*
- *"Este módulo creció demasiado, convendría dividirlo en dos servicios."*

**¿Qué suele ocurrir normalmente?**
1. **Si intentas implementarlo en el momento:** Rompes tu estado de flujo (*deep work*), te desvías del objetivo actual y caes en un agujero de conejo de distracciones.
2. **Si lo dejas en tu cabeza o en un archivo `.txt`:** Se olvida, se traspapela y jamás se llega a construir.
3. **Si abres herramientas en la nube (Jira, Linear, Asana):** La burocracia de crear un ticket con 10 campos rompe la inercia para una idea que pensaste en 5 segundos.

---

### La Solución RequireFlow: Captura sin Fricción, Organización por Tema y Complejidad, Ejecución Garantizada

**RequireFlow está diseñado para que ninguna idea se quede en el limbo:**
Cuando se te ocurra una idea rápida y no sepas exactamente cuándo la vas a hacer, **simplemente pídele a tu agente de IA que te la guarde para otro día**.

```
  💭 Tienes una idea rápida mientras programas
                     │
                     ▼
  🗣️ "Guárdame esta idea para después: meter login con Google (Complejidad media, Auth)"
                     │
                     ▼
  📂 RequireFlow la guarda y organiza en tu base de datos local:
     • Agrupada por Tema: Frontend, Backend, Base de Datos, UI, Seguridad...
     • Agrupada por Complejidad y Prioridad: Chica / Mediana / Grande (Story Points: 1, 3, 5, 8...)
                     │
                     ▼
  🧠 Tu mente queda despejada para continuar con tu tarea actual sin distracciones.
                     │
                     ▼
  🚀 Cuando decidas retomarla (hoy, mañana o la próxima semana):
     Solo dices: "¿Qué sigue?" o "Haz la siguiente tarea" ➔ Tu agente la toma del backlog y la ejecuta.
```

Tanto si es una mejora minúscula de 5 minutos como si es una arquitectura grande, **la idea queda clasificada, ordenada y lista para ser ejecutada cuando sea su momento.**

---

## 🧭 Características Principales

1. **Local-First Zero Config**: Cero servidores externos. Opera sobre un archivo SQLite embebido en `~/.requireflow/requireflow.db` con modo WAL ultrarrápido.
2. **Protocolo MCP para Agentes de IA**: Expone 12 herramientas nativas sobre `stdio` (`rf_project_detect`, `rf_project_add`, `rf_task_add`, `rf_task_next`, `rf_task_start`, `rf_task_complete`, etc.) para que Cursor, Claude Code, Antigravity o Windsurf gestionen el backlog de forma autónoma.
3. **Agrupación por Tema y Complejidad**:
   - **Secciones temáticas**: Frontend, Backend, UI, Database, Bugfixes (con colores personalizables).
   - **Estimación**: Story points y prioridades (`blocker`, `high`, `medium`, `low`).
4. **Archivado Dual (Kanban Limpio)**: Resuelve el problema del "Done infinito". Las tareas completadas esperan el umbral configurado por proyecto (`archive_threshold_hours`, 24h por defecto) y después se archivan automáticamente al Historial Permanente con búsqueda FTS5. El archivado manual (`--force`) sigue disponible para limpiar el tablero al instante. El paso automático corre mientras haya un proceso vivo (`requireflow ui`, `requireflow mcp` o cualquier comando); si nada estuvo corriendo, se pone al día en el siguiente arranque.
5. **Dashboard Web Vanilla Embebido**: Interfaz HTML5/CSS3/JS servida con `Bun.serve()` sin webpack, sin react y con respuesta en `< 5ms`.
6. **Métricas de Eficiencia**: Mide el Tiempo de Ciclo real (`started_at` a `completed_at`), Lead Time y velocidad de resolución de errores.

---

## 🚀 Inicio Rápido

### 1. Requisitos
- **Bun**: v1.1.0 o superior ([bun.sh](https://bun.sh))

### 2. Instalación
```bash
# Clonar e instalar dependencias
git clone https://github.com/joaquinlosvein17bv/Requireflow.git
cd Requireflow
bun install
```

### 3. Ejecutar las Pruebas Unitarias
```bash
bun test
```

### 4. Iniciar la Interfaz Web (Dashboard)
```bash
# Servidor web en http://localhost:4242
bun run ui:dev

# O usando el comando global:
requireflow ui --port 4242
```
*(Para apagar el servidor web, solo presiona `Ctrl + C`).*

### 5. Compilar Binario Autónomo
```bash
bun run build
# Genera dist/requireflow (o dist/requireflow.exe en Windows) y copia el
# dashboard a dist/ui, que es lo que resuelve el binario en cualquier cwd.
```

---

## 💻 Comandos CLI

```bash
# Inicializar o vincular el directorio actual como proyecto activo
requireflow init

# Ver el estado del tablero (Por Hacer, En Progreso, Completadas)
requireflow status

# Guardar una idea rápida en el backlog agrupada por tema y prioridad
requireflow add "Soportar autenticación con Google" -t feature -p high -s Backend

# Pedir la siguiente tarea de mayor prioridad para trabajar
# (considera las columnas To Do y Backlog, respetando prioridad y orden del tablero)
requireflow next
requireflow next --json

# Iniciar una tarea (marca el cronómetro started_at)
requireflow start <task-id>

# Completar una tarea (calcula tiempo de ciclo y guarda notas de solución)
requireflow done <task-id> -m "Implementado con OAuth2 y tokens JWT"

# Abrir el Dashboard Web en el navegador
requireflow ui --port 4242

# Iniciar servidor MCP por stdio
requireflow mcp

# Archivar tareas completadas
#   sin --force respeta archive_threshold_hours del proyecto
#   --force limpia la columna Done al instante
requireflow archive
requireflow archive --force
requireflow archive --threshold 6

# Ver estadísticas de eficiencia y velocidad de desarrollo (ventana configurable)
requireflow stats
requireflow stats --days 90

# Generar datos de demostración en una base separada (~/.requireflow/demo.db)
bun run src/db/seed.ts
bun run src/db/seed.ts --reset
```

---

## 🔌 Configuración en Agentes de IA (MCP)

Para conectar `requireflow` con Cursor, Claude Desktop, Antigravity, Cline o Windsurf:

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

*O ejecutando directamente desde el código fuente con Bun:*
```json
{
  "mcpServers": {
    "requireflow": {
      "command": "bun",
      "args": ["run", "RUTA_ABSOLUTA/bin/requireflow.ts", "mcp"]
    }
  }
}
```

### Herramientas MCP Registradas:
| Herramienta | Alias | Propósito |
| :--- | :--- | :--- |
| `rf_project_detect` | `project_current` | Detecta el proyecto dueño del directorio de trabajo. **Solo lectura**: nunca crea proyectos. |
| `rf_project_list` | `project_list` | Lista los proyectos registrados con su ruta raíz y cantidad de tareas activas. |
| `rf_project_add` | `project_create` | Registra un proyecto explícitamente. Con `rootPath` es idempotente: devuelve el existente. |
| `rf_task_add` | `task_create` | Guarda una idea rápida en el backlog con su tema, tipo, prioridad y descripción. |
| `rf_task_next` | `task_next` | Siguiente tarea elegible (`backend`/`todo`) según prioridad y orden del tablero. |
| `rf_task_start` | `task_start` | Marca la tarea en progreso y comienza a cronometrar el ciclo (`started_at`). Reabre tareas completadas o archivadas limpiando sus marcas anteriores. |
| `rf_task_complete` | `task_complete` | Marca la tarea completada, registra un ciclo y guarda notas técnicas. Repetirla no altera nada. |
| `rf_task_list` | `task_list` | Lista tareas activas con filtros por sección, estado, prioridad o tipo. |
| `rf_task_update` | `task_update` | Modifica título, prioridad, sección, tipo, estado o descripción. Las transiciones de estado ilegales se rechazan. |
| `rf_archive_run` | `task_archive_done` | Archiva tareas completadas. Respeta el umbral salvo `forceManual: true`. |
| `rf_history_search` | `history_list` | Búsqueda FTS5 (ranking BM25) en tareas pasadas y notas de solución. |
| `rf_efficiency_stats`| `efficiency_stats` | Tiempo de ciclo, lead time, throughput y velocidad de bugfix para la ventana pedida. |

> Todos los identificadores de proyecto deben existir. Si pasás un `projectId` inexistente la herramienta falla con un error explícito en lugar de escribir en otro proyecto.

---

## 🔒 API Local y Seguridad

El dashboard y la API REST escuchan solo en loopback (`127.0.0.1`) y aplican tres controles independientes:

1. **Host permitido**: solo `127.0.0.1`, `localhost` o `[::1]` con el puerto del servidor (protege contra DNS rebinding).
2. **Origen permitido**: el CORS se responde únicamente al origen del propio servidor; pedidos cross-site no pueden leer ni escribir.
3. **Token de mutación**: las operaciones que modifican datos (`POST`, `PATCH`, `PUT`, `DELETE`) requieren el header `X-RequireFlow-Token`. El dashboard lo obtiene de `GET /api/health`, que solo es legible desde el mismo origen.

Para scripts locales:

```bash
TOKEN=$(curl -s http://127.0.0.1:4242/api/health | jq -r .token)
curl -X POST http://127.0.0.1:4242/api/projects \
  -H "Content-Type: application/json" \
  -H "X-RequireFlow-Token: $TOKEN" \
  -d '{"name":"Mi proyecto"}'
```

El token no es autenticación de usuario: la frontera real sigue siendo el archivo SQLite local. Su objetivo es cerrar la superficie de ataque del navegador.

---

## 📦 Variables de Entorno

| Variable | Valor por defecto | Descripción |
| :--- | :--- | :--- |
| `REQUIREFLOW_DB_PATH` | `~/.requireflow/requireflow.db` | Ubicación del archivo de base de datos SQLite |
| `REQUIREFLOW_PORT` | `4242` | Puerto del servidor web y API REST |
| `REQUIREFLOW_HOST` | `127.0.0.1` | Host de enlace del servidor HTTP |
| `REQUIREFLOW_UI_DIR` | auto | Directorio con `index.html` para servir un dashboard propio (el binario trae el suyo en `dist/ui`) |
| `REQUIREFLOW_DEMO_DB_PATH` | `~/.requireflow/demo.db` | Base separada que usa `bun run src/db/seed.ts`; nunca toca la base real |
