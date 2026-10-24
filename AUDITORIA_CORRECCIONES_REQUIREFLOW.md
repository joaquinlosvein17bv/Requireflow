# Auditoría y Correcciones — RequireFlow

Fecha: 2026-10-24
Base auditada: `badabdd` (main, 18 tests verdes, typecheck roto)
Estado final: `167f181` (main), 125 tests verdes, typecheck en cero, build con dashboard empaquetado.

---

## 1. Resumen ejecutivo

**Estado inicial.** El proyecto tenía 18 tests que pasaban y ninguna garantía real:

- El typecheck **nunca corrió**: `tsconfig.json` usaba `baseUrl`, eliminado en TypeScript 7 (el `devDependency` declarado), así que `tsc` abortaba con `TS5102` antes de leer un archivo.
- La identidad de proyecto era el nombre de la carpeta: dos repos llamados `backend` compartían backlog y se sobrescribían la ruta.
- El dashboard ejecutaba JavaScript almacenado (título de tarea, nombre y color de sección) y la API local respondía con `Access-Control-Allow-Origin: *` sin ninguna protección.
- El archivado automático a 24 h era una promesa del README sin implementación: el único camino real era `force: true`, aplicado siempre por un bug de parseo.
- Las fechas mezclaban `CURRENT_TIMESTAMP` de SQLite (UTC sin zona) con ISO de JavaScript, y `new Date()` interpretaba el primer formato como hora local: el lead time estaba desplazado por el huso del equipo.
- La tabla de historial se borraba en cascada con las tareas que decía preservar.

**Estado final.** Las 24 observaciones consolidadas fueron verificadas y corregidas en la causa raíz, más 6 defectos adicionales descubiertos durante el trabajo. Cada corrección tiene una prueba que falla sin ella, cinco migraciones versionadas que preservan todos los datos, y un commit independiente con push a `main`.

**Evidencia global**

| Verificación | Antes | Después |
|---|---|---|
| `bun test` | 18 pass / 0 fail | **125 pass / 0 fail** |
| `bun run typecheck` | TS5102 (config inválida, 0 archivos chequeados) | **exit 0**, 0 errores |
| `bun run build` | binario sin dashboard al lado | **`dist/requireflow` + `dist/ui`** |
| Migración sobre copia de la base real | n/a | 5/5 migraciones, **5 proyectos / 22 secciones / 52 tareas / 5 historial preservados**, ids y asignaciones idénticos |
| XSS en navegador real | `window.__xss` se ejecutaba | **`null`**, 0 elementos inyectados |
| API desde otro origen | `*` y sin token | **403** sin token, **403** con origen ajeno, **403** con Host falso |
| Posiciones concurrentes | colisión/lock | 3 procesos × 8 inserciones → **24 tareas, 24 posiciones únicas**, 10/10 corridas limpias |

---

## 2. Tabla de hallazgos

| ID | Hallazgo | Estado | Evidencia |
|---|---|---|---|
| RF-01 | Identidad de proyecto por nombre | **Corregido** | `test/project-identity.test.ts` (11 tests), migración 2 |
| RF-02 | MCP escribe en proyecto incorrecto | **Corregido** | `test/mcp.test.ts` (6 herramientas fallan sin escribir) |
| RF-03 | XSS almacenado en el dashboard | **Corregido** | `test/ui-security.test.ts` + verificación Playwright |
| RF-04 | API local sin controles | **Corregido** | `test/api-security.test.ts` (12 tests) |
| RF-05 | Pérdida de historial al borrar tareas | **Corregido** | `test/history-preservation.test.ts` (4 tests), migración 5 |
| RF-06 | Sección de otro proyecto | **Corregido** | `test/task-section.test.ts` (4 tests) |
| RF-07 | Archivado forzado siempre | **Corregido** | `test/archive.test.ts` (7 tests) |
| RF-08 | Archivado automático inexistente | **Corregido** | reloj controlado en `test/archive.test.ts` |
| RF-09 | Máquina de estados inconsistente | **Corregido** | `test/task-state.test.ts` (7 tests) |
| RF-10 | Historial duplicado | **Corregido** | `test/task-state.test.ts`, migración 4 |
| RF-11 | Formatos de fecha inconsistentes | **Corregido** | `test/time-metrics.test.ts` (8 tests), migración 3 |
| RF-12 | Consulta FTS5 defectuosa | **Corregido** | `test/migrations.test.ts` + búsqueda sin `projectId` |
| RF-13 | `next` ignora el backlog | **Corregido** | `test/ordering.test.ts` |
| RF-14 | GET crea proyectos | **Corregido** | `test/api-detection.test.ts` (5 tests) |
| RF-15 | Detección desde subdirectorios | **Corregido** | `test/project-identity.test.ts`, `test/api-detection.test.ts` |
| RF-16 | Orden y concurrencia de `position` | **Corregido** | `test/ordering.test.ts` + fixture multi-proceso |
| RF-17 | Cierre de conexiones ajenas | **Corregido** | `test/connection.test.ts` (4 tests) |
| RF-18 | Typecheck roto | **Corregido** | `bun run typecheck` exit 0 |
| RF-19 | Validación CLI | **Corregido** | `test/cli-validation.test.ts` (9 tests) |
| RF-20 | Validación HTTP | **Corregido** | `test/api-validation.test.ts` (11 tests) |
| RF-21 | Resolución y empaquetado de UI | **Corregido** | `test/ui.test.ts` (4 tests) + binario compilado |
| RF-22 | Métricas inconsistentes | **Corregido** | `test/time-metrics.test.ts` |
| RF-23 | Datos demo y código residual | **Corregido** | `test/seed.test.ts` (5 tests) |
| RF-24 | Documentación y CI | **Corregido** | `test/migrations.test.ts` (5 tests), `.github/workflows/ci.yml` |

Ningún hallazgo quedó "no reproducible": los 24 se reprodujeron antes de corregirse.

### Defectos adicionales descubiertos (RF-25 … RF-30)

| ID | Hallazgo | Origen | Estado |
|---|---|---|---|
| RF-25 | Inicialización concurrente fallaba con `SQLITE_BUSY`: `busy_timeout` se fijaba después de cambiar a WAL y las migraciones verificaban su versión fuera del lock | prueba de concurrencia de RF-16 | **Corregido** |
| RF-26 | Un `.git` en un directorio ancestro (p. ej. el home) hacía que cualquier carpeta se resolviera como ese repositorio; la detección nunca encontraba un proyecto registrado en una carpeta común | prueba de RF-14 | **Corregido** |
| RF-27 | `REQUIREFLOW_ARCHIVE_HOURS` documentada pero nunca leída | RF-23 | **Corregido** (documentación) |
| RF-28 | `agent.md` era una copia byte a byte de `AGENTS.md` | RF-24 | **Corregido** |
| RF-29 | `total_cycle_time_ms` duplica `cycle_time_seconds` en `history` | RF-22 | **Conservado** por compatibilidad, documentado |
| RF-30 | `PATCH /api/tasks/:id` usa `section_id`/`story_points` mientras `POST` usa `sectionId`/`storyPoints` | RF-20 | **Conservado** por compatibilidad con el dashboard actual, ambos aceptados |

---

## 3. Causa raíz y solución por defecto

### RF-01 — Identidad de proyecto
**Causa.** `projects.name` tenía índice `UNIQUE` y `getOrCreateProject` buscaba por nombre, actualizando `root_path` del registro encontrado. Dos carpetas homónimas compartían fila; el segundo checkout reescribía la ruta del primero.
**Solución.** Identidad = `root_key`: ruta absoluta, separadores `/`, sin barra final, en minúsculas en Windows (`src/domain/root-path.ts`). Migración 2 elimina el índice único de `name`, agrega `root_key`, lo rellena y crea un índice único parcial. Si dos filas antiguas normalizan al mismo root, la segunda queda desvinculada (`root_key = NULL`) y se registra un warning: nunca se fusionan ni se reparten tareas sin evidencia. `findProjectsWithMissingRoots` lista los proyectos cuyo root ya no existe, que es el síntoma de una colisión histórica.

### RF-02 — Proyecto explícito inexistente
**Causa.** `resolveProjectId` caía a `process.cwd()` cuando no encontraba el id.
**Solución.** Con id explícito, si no existe lanza `Project not found with ID: <id>` e indica `rf_project_list` / `rf_project_detect`. La resolución automática queda solo para llamadas sin id. Se agrega `rf_project_add` (idempotente con `rootPath`) para que un agente pueda registrar sin depender de efectos colaterales.

### RF-03 — XSS almacenado
**Causa.** `innerHTML` interpolaba título, descripción, `section_name`, `section_color` y el mensaje del toast (que incluía el título de la tarea).
**Solución.** `src/ui/safe-dom.js` con `createEl` (todo texto pasa por `createTextNode`), `escapeHtml` para casos residuales y `safeColor` (solo `#rgb`/`#rrggbb`/`#rrggbbaa` o nombre CSS). Todos los renderizadores dinámicos se reescribieron con `createEl` y los listeners se enlazan al nodo creado. El cliente pasa a cargarse como módulo ES. Test de invariante: ninguna asignación a `innerHTML` puede contener `${}`.

### RF-04 — API local
**Causa.** `Access-Control-Allow-Origin: *` y ningún control sobre mutaciones; cualquier página podía leer y borrar el backlog.
**Solución.** `src/server/security.ts` con tres controles independientes: `Host` solo loopback (DNS rebinding), origen permitido (solo el del propio servidor, `null` rechazado) y token de mutación por proceso (`X-RequireFlow-Token`) obtenible en `GET /api/health`, ilegible desde otro origen. Se documenta explícitamente que no es autenticación de usuario: la frontera real sigue siendo el archivo SQLite.

### RF-05 — Historial
**Causa.** `history.task_id ... ON DELETE CASCADE`, y `section_name` se resolvía con JOIN a `sections`.
**Solución.** Migración 5 reconstruye `history` con `task_id` nullable y `ON DELETE SET NULL`, agrega snapshots `section_name`/`section_color`, recrea índices y triggers FTS y reconstruye el índice. Política explícita: el historial sobrevive al borrado de tareas y secciones y solo se elimina con su proyecto.

### RF-06 — Sección cruzada
**Causa.** La FK solo probaba que la sección existía.
**Solución.** `assertSectionBelongsToProject` en `createTask` y `updateTask`, antes de escribir, con mensaje que distingue "no existe" de "es de otro proyecto"; la API lo mapea a 422.

### RF-07 — Force
**Causa.** `flags["force"] !== false` es siempre `true` (`undefined !== false`).
**Solución.** `flagToBoolean` con valores explícitos; `--force`, `--force=true`, `--force=false`; `parseArgs` acepta `--key=value`.

### RF-08 — Archivado automático
**Causa.** Ningún caller usaba `forceManual: false` y no existía ningún disparador.
**Solución.** `autoArchiveAllProjects` + `startAutoArchive` (arranque y cada 60 s, timer `unref`) en los servidores HTTP y MCP, respetando `archive_threshold_hours` por proyecto. Idempotente por `INSERT OR IGNORE` + `UNIQUE(task_id)`. Documentado: si no hay proceso vivo, se pone al día en el siguiente arranque.

### RF-09 / RF-10 — Estados e historial duplicado
**Causa.** Los estados se escribían desde cualquier superficie y `archiveDoneTasks` podía insertar dos filas para la misma tarea.
**Solución.** `LEGAL_TRANSITIONS` + `planTransition`: una sola función decide transiciones legales y qué timestamps se limpian al reabrir. `completeTask` repetido es no-op. Migración 4 colapsa duplicados (conserva el más reciente) y agrega `UNIQUE(task_id)`.

### RF-11 / RF-22 — Tiempo y métricas
**Causa.** Dos representaciones temporales mezcladas y comparaciones SQL entre ISO y `datetime()`; `dailyTrends` fijo en 7 días.
**Solución.** `src/domain/time.ts` como única fuente de relojes; todo se escribe ISO UTC con `Z`. Migración 3 normaliza lo existente con `strftime` (sin adivinar husos) y crea `task_cycles`, con un ciclo histórico por tarea ya completada. Las métricas se calculan sobre ciclos con ventanas ISO calculadas en JS, y `dailyTrends` genera la serie densa del período pedido.

### RF-12 — FTS5
**Causa.** `conditions.slice(1).join(" AND " || "")` dejaba `... MATCH ? AND LIMIT ?`; la excepción la tapaba el fallback `LIKE`.
**Solución.** Construcción correcta de condiciones, sin `AND` colgante, conservando ranking BM25.

### RF-13 / RF-16 — Cola y orden
**Solución.** `ELIGIBLE_STATUSES = ["todo", "backlog"]`, un único `TASK_ORDER_BY` (prioridad → posición → creación → id) compartido por tablero y `next`, y `MAX(position)+1` dentro de una transacción `IMMEDIATE`.

### RF-14 / RF-15 — Detección
**Solución.** `detectProject` es solo lectura y resuelve: coincidencia exacta del directorio → raíz de repositorio registrada → root contenedor más profundo, nunca a través de una frontera git. `GET /api/projects/current` valida el `cwd` y devuelve 404 con `suggested_name` en lugar de crear.

### RF-17 — Conexiones
**Solución.** Caché `Map` por ruta resuelta; `closeDatabase(path)` cierra solo esa entrada.

### RF-18 — Typecheck
**Solución.** `tsconfig` corregido (sin `baseUrl`/`paths`), `noUnusedLocals`/`noUnusedParameters`, tests incluidos en el programa. Los 32 errores se corrigieron en origen (`pathParam`, guardas de acceso, registro tipado de herramientas MCP con los tipos del SDK). Script `typecheck` y paso en CI.

### RF-19 / RF-20 — Validación
**Solución.** CLI: `flagToBoolean`/`flagToNumber` con rangos y enums del dominio, errores descriptivos y `try/catch` que evita volcar stacks. HTTP: `readJsonBody`, `requireText`, `optionalText`, `optionalEnum`, `optionalInt`, `optionalTags`, `optionalColor`, `intParam`; 400/404/422/500 correctos y `Internal server error` genérico con el detalle solo en el log.

### RF-21 — UI
**Solución.** Resolución solo por override explícito, `REQUIREFLOW_UI_DIR`, `<exe dir>/ui`, `src/ui` relativo al módulo y fallback legacy; nunca `cwd`. `scripts/bundle-ui.ts` copia el dashboard junto al binario. Contención de rutas con `path.resolve` + verificación de prefijo tras decodificar. `public/` eliminado.

### RF-23 / RF-24 — Demo, código muerto y documentación
**Solución.** Demo en base separada (`~/.requireflow/demo.db`), sin rutas hardcodeadas, borrado por id y solo con `--reset`. Código muerto eliminado (`CORS_HEADERS`, `getHistoryItem`, imports sin uso); `config` documentada como reservada. README y AGENTS.md sincronizados (12 herramientas, semántica real de archivado, seguridad de la API, variables reales); `agent.md` pasa a puntero; CI con install, typecheck, tests y build.

---

## 4. Archivos modificados

`55 files changed, 5220 insertions(+), 3414 deletions(-)` entre `badabdd` y `167f181`.

**Nuevos:** `src/domain/root-path.ts`, `src/domain/time.ts`, `src/server/security.ts`, `src/ui/safe-dom.js`, `src/cli/flags.ts`, `scripts/bundle-ui.ts`, `.github/workflows/ci.yml`, `test/helpers.ts`, `test/fixtures/insert-tasks.ts` y 12 archivos de test nuevos.

**Reescritos:** `src/domain/{project,task,efficiency,history,archive,section}.ts`, `src/db/{migrations,seed,connection}.ts`, `src/server/{http,routes}.ts`, `src/mcp/{tools,server}.ts`, `src/cli/index.ts`, `src/ui/{app.js,index.html}`, `tsconfig.json`, `README.md`, `AGENTS.md`, `agent.md`, `.gitignore`.

**Eliminados:** `public/` (copia byte a byte de `src/ui/`).

---

## 5. Migraciones y preservación de datos

Respaldo previo: `~/.requireflow/backups/requireflow-pre-audit-20261024-094951.db` (`VACUUM INTO`, copia consistente con WAL activo).

| Versión | Nombre | Efecto |
|---|---|---|
| 2 | `project_identity_by_root_path` | quita `UNIQUE(name)`, agrega `root_key`, lo rellena, índice único parcial |
| 3 | `canonical_time_and_task_cycles` | normaliza timestamps a ISO UTC, crea `task_cycles` y rellena un ciclo por tarea completada |
| 4 | `history_one_row_per_task` | colapsa duplicados de historial y agrega `UNIQUE(task_id)` |
| 5 | `history_preserved_after_task_delete` | reconstruye `history` con `ON DELETE SET NULL` y snapshots de sección, recrea índices/triggers/FTS |

Cada migración verifica y aplica dentro de una transacción `IMMEDIATE`, así que dos procesos abriendo la base a la vez no chocan.

**Verificación sobre la base real (copia exacta):** 5 proyectos, 22 secciones, 52 tareas y 5 filas de historial antes y después; ids de proyecto idénticos; asignación tarea→proyecto idéntica; 29 ciclos históricos creados; 0 fechas no ISO; FTS sigue resolviendo ("Configurar" → 1 resultado); `task_id` nullable.

**La base real del usuario no fue modificada durante la auditoría.** Las migraciones se aplican automáticamente en el próximo arranque de cualquier comando; existe el respaldo indicado arriba.

---

## 6. Pruebas incorporadas

De 18 a **125** tests (21 archivos). Nuevos por área:

| Archivo | Tests | Cubre |
|---|---|---|
| `project-identity.test.ts` | 11 | aislamiento entre homónimos, nombres compartidos, variantes de ruta, subdirectorio, umbrella, detección sin escritura, claim legacy, migración v1→v2 |
| `migrations.test.ts` | 5 | cadena v1→v5, preservación de filas, timestamps, backfill de ciclos, dedupe de historial, idempotencia |
| `time-metrics.test.ts` | 8 | ISO canónico, ciclo de 10 min, lead time sin desfase, ventana exacta, reapertura con 2 ciclos, serie diaria, distribución/velocidad/throughput |
| `task-state.test.ts` | 7 | camino normal, completado idempotente, reapertura, restauración, transiciones ilegales, estado repetido, historial único |
| `archive.test.ts` | 7 | umbral 23 h/25 h, force opt-in, umbral por proyecto, flags, archivado automático, idempotencia |
| `api-security.test.ts` | 12 | token faltante/erróneo, origen ajeno, `null`, mismo origen, sin `*`, rebinding, preflight |
| `api-validation.test.ts` | 11 | JSON inválido, campos requeridos, enums 422, paginación, 404, 500 sin fugas, color |
| `api-detection.test.ts` | 5 | 404 sin crear, detección sin escribir, subdirectorio, `cwd` inválido |
| `ui.test.ts` | 4 | UI propia sin `uiDir`, independencia de `cwd`, assets, traversal |
| `ui-security.test.ts` | 4 | escape, colores, invariante `innerHTML`, script como módulo |
| `ordering.test.ts` | 5 | backlog elegible, prioridad, posición, desempate, concurrencia multi-proceso |
| `cli-validation.test.ts` | 9 | tipo/prioridad inválidos, puerto, umbral, días, comando desconocido, tarea inexistente |
| `seed.test.ts` | 5 | aislamiento, repetibilidad, sin rutas, historial, reset |
| `connection.test.ts` | 4 | consumidores independientes, caché por ruta, aislamiento de escritura |
| `task-section.test.ts` | 4 | sección cruzada en alta y edición, limpieza, inexistente |
| `history-preservation.test.ts` | 4 | borrado de tarea, de sección, de proyecto, reconstrucción |

---

## 7. Resultados verificables

```
$ bun test
125 pass
0 fail
454 expect() calls
Ran 125 tests across 21 files.

$ bun run typecheck
$ tsc --noEmit
(exit 0)

$ bun run build
compile dist/requireflow.exe
Bundled dashboard into dist/ui
```

---

## 8. Validaciones de seguridad y concurrencia

**Navegador real (Playwright/Chromium)**
- Título de tarea y nombre de sección `<img src=x onerror="window.__xss=(window.__xss||0)+1">`: renderizado como texto, `window.__xss === null`, 0 elementos `<img>` inyectados.
- Toast de inicio con el mismo payload: texto inerte, 0 elementos inyectados.
- Flujo completo del dashboard contra servidor vivo: crear proyecto, crear tarea, editar (PATCH con el payload real), iniciar, completar, archivar, historial y métricas. Cero errores de consola.
- Dataset demo servido: Kanban 4/2/2, métricas con 30 filas de tendencia y título "Últimos 30 días", historial con 5 filas y snapshot de sección.
- Estado sin proyecto: muestra "Sin proyecto vinculado" y no crea nada.

**API**
- `POST` sin token → 403 sin escribir. Con token y origen ajeno → 403. Origen `null` → 403. Mismo origen con token → 201.
- `Access-Control-Allow-Origin` nunca `*`; sin cabecera para orígenes no autorizados.
- `Host: attacker.example:4403` → 403 (rebinding).
- Preflight permitido solo para el origen propio.

**Binario compilado**
- Ejecutado desde un directorio ajeno que contenía un `src/ui` señuelo: sirve el dashboard correcto (`<title>RequireFlow`, sin `FOREIGN`), `/api/health` entrega el token, `POST` sin token → 403, con token → 201.

**Concurrencia**
- 3 procesos insertando 8 tareas cada uno en la misma base: 24 tareas, 24 posiciones únicas, 10/10 corridas sin `SQLITE_BUSY`.
- Migraciones concurrentes: verificación y aplicación dentro de transacción `IMMEDIATE`.

**Preservación de datos**
- Migración completa sobre copia de la base real: todas las filas e ids preservados, FTS operativo.

---

## 9. Decisiones arquitectónicas y justificación

1. **`root_key` en vez de reescribir la tabla de proyectos.** El `UNIQUE(name)` era un índice externo, así que `DROP INDEX` + índice no único evita un rebuild de tabla con riesgo de datos.
2. **`task_cycles` como fuente única de duración.** Permite reaperturas sin sobrescribir métricas históricas y hace que "una fila por completado" sea un invariante verificable. `tasks.cycle_time_seconds` queda como caché de presentación.
3. **Un registro de historial por tarea.** Es el contrato que el README promete ("historial permanente"), y `UNIQUE(task_id)` lo hace imposible de romper por código nuevo.
4. **Modelo de seguridad de la API sin autenticación de usuario.** La frontera real es el archivo local; el riesgo concreto es el navegador. Host + origen + token de mutación cierran CSRF, lectura cross-origin y rebinding sin agregar gestión de usuarios ni dependencias.
5. **UI empaquetada junto al binario.** Evita depender de `cwd` o de `import.meta.dir` dentro del bunfs y mantiene una sola fuente de verdad (`src/ui`).
6. **Archivado automático oportunista.** Un proyecto local-first no puede prometer un demonio; se ejecuta al arrancar y cada 60 s mientras haya proceso, con puesta al día idempotente.
7. **Colisiones históricas no se separan.** Repartir tareas entre dos proyectos que compartieron nombre requeriría evidencia que la base no tiene; se detectan y se informan.
8. **`server.tool` tipado con los tipos del SDK.** El wrapper genérico rompía la resolución de overloads; se reemplazó por un registro que conserva la inferencia por esquema literal, sin `any` ni `@ts-ignore`.

---

## 10. Riesgos residuales y limitaciones

- **Datos históricos de una colisión real** (dos repos `backend` que efectivamente compartieron fila antes de esta versión) no pueden separarse automáticamente: quedan mezclados en el proyecto sobreviviente. `findProjectsWithMissingRoots` los señala para revisión manual.
- **`total_cycle_time_ms`** sigue duplicando `cycle_time_seconds` en `history` por compatibilidad de contrato.
- **`PATCH /api/tasks/:id`** acepta `section_id`/`story_points` (dashboard actual) además de `sectionId`/`storyPoints`; la inconsistencia se conserva para no romper clientes.
- **La tabla `config`** sigue sin consumidores; se conserva documentada como reservada.
- **El token de la API** es por proceso: reiniciar el servidor invalida un token cacheado por un script. El dashboard lo reobtiene solo.
- **El archivado automático** no corre sin proceso vivo; se recupera en el siguiente arranque, no en tiempo real.
- **Concurrencia**: SQLite serializa escrituras; con muchos agentes simultáneos el `busy_timeout` de 5 s puede agotarse y devolver error. No se agregó reintento con backoff.
- **Fechas previas a la migración** se interpretaron como UTC (que es lo que `CURRENT_TIMESTAMP` produce); timestamps escritos por herramientas externas en hora local quedarían desplazados.
- **Cobertura de navegador**: la verificación con Playwright es manual y no está en CI (requeriría instalar navegadores).

---

## 11. Commits

18 commits, cada uno con su push a `origin/main`:

| Commit | RF | Tema |
|---|---|---|
| `1a86026` | RF-18 | tsconfig para TS7 y 32 errores estrictos |
| `d2b5a6d` | RF-21 | UI única resuelta sin `cwd` |
| `a0cd96a` | RF-03 | XSS almacenado |
| `d3abe2e` | RF-17 | conexiones por ruta |
| `bde90b9` | RF-01/15 | identidad por `root_key` + migración 2 |
| `b229c38` | RF-02 | `projectId` inexistente + `rf_project_add` |
| `0a6d480` | RF-06 | secciones entre proyectos |
| `0293ce2` | RF-11/22 | tiempos ISO, `task_cycles`, métricas + migración 3 |
| `fb5d4e5` | RF-09/10 | máquina de estados + historial único + migración 4 |
| `d774703` | RF-05 | historial preservado + migración 5 |
| `a77ba0e` | RF-07/08 | force opt-in + archivado automático |
| `5836501` | RF-13/16 | orden único + concurrencia + RF-25 |
| `dfd981f` | RF-14/26 | detección de solo lectura |
| `3079fbd` | RF-04 | modelo de seguridad de la API |
| `532f9c3` | RF-19 | validación CLI |
| `153ae74` | RF-20 | validación HTTP y errores |
| `8484892` | RF-23 | demo aislada y código muerto |
| `167f181` | RF-24 | documentación, CI y `agent.md` |

---

## 12. Recomendaciones para prevenir la repetición

1. **El typecheck es un gate, no un adorno.** Ya está en CI; cualquier PR que lo rompa no debe mezclarse.
2. **Toda invariante necesita una prueba que falle sin la corrección.** Los 18 tests originales no detectaban ninguno de los 24 defectos porque solo recorrían el camino feliz.
3. **Un test de concurrencia por operación que calcula `MAX(...)+1`.** El fixture multi-proceso encontró `SQLITE_BUSY` que ninguna prueba secuencial podía ver.
4. **Una sola representación temporal.** Cualquier `CURRENT_TIMESTAMP` nuevo en SQL debe tratarse como bug; el reloj vive en `src/domain/time.ts`.
5. **Nunca `innerHTML` con datos.** El test de invariante sobre `app.js` convierte esa regla en algo ejecutable.
6. **Un `GET` no escribe.** Si una ruta de lectura necesita crear algo, es una ruta de escritura con nombre propio.
7. **Migración + respaldo en el mismo commit** que cambia el esquema, y replay sobre una copia de datos reales antes de tocar producción.
8. **Contratos de agente explícitos.** Un `projectId` inválido debe fallar, nunca "resolver" a otro proyecto: un agente que escribe en el lugar equivocado es peor que uno que se detiene.
