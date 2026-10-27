# RequireFlow 2 — Product Backlog + ODD

Objective: evolucionar RequireFlow a un Product Backlog local-first con ideas, épicas, historias, grupos de experiencia G##, decisiones D###, criterios AC estables, aprobación humana de alcance y aceptación humana de resultado, manteniendo intactos `tasks`, `task_cycles`, `history` y las métricas.
Branch: `feat/requireflow-2-product-backlog` (creada desde `main` en `629b5f1`). Delivery: `feature-branch-chain`, commits por unidad; push y PR quedan a decisión humana. Runner: `bun test`. Typecheck: `bun run typecheck`. Build: `bun run build`.

## Specs

S1 (R0) Baseline y seguridad de datos. "Antes de migrar una SQLite real, crea una copia verificable; prueba antes la migración con fixtures de versiones anteriores. Migraciones aditivas, transaccionales, idempotentes, con verificación de integridad; no elimines ni reinterpretas filas existentes." "Los informes de auditoría anteriores son hipótesis; prevalece el código que realmente encuentres." No cambiar tests para encubrir regresiones.

S2 (Visión 1) "Anotar una idea en segundos, sin interrumpir la tarea actual y sin convertirla en trabajo ejecutable."

S3 (Visión 2) "extraer épicas e historias y agrupar automáticamente todas las historias conocidas en grupos de experiencias funcionales G01, G02, etc. Un grupo puede combinar historias de distintas épicas. Las historias deben verse tanto por épica como por grupo."

S4 (Visión 3) Grupos futuros "como propuestas flexibles: orden y dependencias visibles, sin exigir refinamiento completo ni aprobación anticipada."

S5 (Visión 4, revisado en L10) Preguntar antes de guardar. "Si una decisión funcional relevante es ambigua, pregúntamela inmediatamente. Haz de una a tres preguntas relacionadas por ronda". "Solo cuando la unidad que deseas registrar esté suficientemente clara y yo haya indicado que quieres registrarla, persiste valores realmente confirmados en RequireFlow." "No persistir NO ESPECIFICADO, TODO, TBD, por definir ni valores por defecto supuestos como requisitos aprobados." "No repitas preguntas ya contestadas." "Una decisión sobre un incremento futuro puede esperar" sin inventar respuesta. Excepción intencional: "captura rápida... guarda inmediatamente solo mis palabras originales en la bandeja de ideas, sin preguntas, sin descomponerlas ni habilitarlas para ejecución." "No exijas resolver todo el producto para iniciar G01."

S6 (Visión 5) "Autorizar explícitamente la revisión exacta del alcance del grupo; delegar implementación a Gentle AI/ODD; recibir evidencias y ponerlo en pendiente_revision_humana."

S7 (Visión 6) "Permitir que yo pruebe y acepte el grupo o reporte defectos para corregir en ese mismo grupo. Repetir corrección → prueba → aceptación tantas veces como haga falta. Un test verde o un agente que dice «terminé» no es aceptación humana."

S8 (Visión 7) "Mostrar G02 como próximo después de aceptar G01, sin ejecutarlo automáticamente."

S9 (Skills) Mantener separadas `skills/product-backlog/SKILL.md` (PO conversacional, entregada por el usuario, no reemplazable por prompt improvisado) y `skills/requireflow-protocol/SKILL.md` (v2, actualizar sin borrar). "La skill de backlog no registra cada microtarea ODD; la de ejecución no aprueba historias ni grupos." Triggers y precedencia sin dobles escrituras. ODD es dueño de `odd/tasks/<feature>.md`, `S#`, `T#`, pruebas y verificaciones; RequireFlow es dueño de intención, decisiones, snapshots, aceptaciones y vínculos/evidencia. "Nunca edites desde RequireFlow el documento interno de tareas ODD".

S10 (Detección) Preservar identidad por ruta normalizada, subcarpetas y límites Git. Detectar cinco situaciones: "carpeta nueva y vacía; repositorio existente no registrado; proyecto ya vinculado; subcarpeta de proyecto; repo Git anidado independiente." "No registrado ≠ vacío." "No crees proyectos fantasma al ejecutar desde escritorio/home o un path no identificado." Nueva raíz explícita: inicialización idempotente; si existe código, vincular y declarar capacidades preexistentes.

S11 (Modos) "Clásico/legacy: los comandos y tareas actuales continúan funcionando sin exigir grupos. Product Backlog: la captura va a ideas, la planificación a historias/grupos y ningún trabajo de producto se selecciona para ejecución sin pertenecer a un grupo aprobado y versión vigente. Tareas legacy sin vínculo siguen visibles; no saltan por accidente al flujo aprobado." Definir vía de mantenimiento autorizada para chores/bugs urgentes.

S12 (Modelo) SQLite sigue siendo la única fuente de verdad; no alterar el significado de `tasks.status`. Modelo mínimo: ideas/work_items (procedencia, estado de definición, ID estable, versión, prioridad, texto original); increments/G## (objetivo, orden, dependencias, estado, revisión, hash de alcance, snapshot); relación historias↔grupos con historial de membresía y reagrupaciones; decisions con `[NO ESPECIFICADO]`, alternativas, respuesta, origen, estado, versión, impacto, supersesión; acceptance_criteria con `AC-G01-###` estable y resultados de verificación humana; registro append-only de cambios y eventos; `increment_reviews`/`review_results`; referencias no duplicadas a ODD. "IDs no se reciclan. Cambios de historias no eliminan AC válidos. Congela snapshot de grupos aprobados." Control de concurrencia `version`/`expectedVersion` y 409, idempotencia y transacciones.

S13 (Deuda) "task_cycles puede perder métricas al borrar tareas, history no refresca snapshots al rearchivar, y el archivado forzado por defecto difiere entre transportes. Soluciona lo imprescindible para integridad del nuevo ciclo, sin romper archivos ni tests antiguos. No utilices el historial archivado de tareas como único historial del producto."

S14 (Agrupación) "La IA propone todos los grupos conocidos automáticamente después de procesar un producto, con objetivos y orden tentativo. No obligar a seleccionar historias manualmente una por una." Historias de distintas épicas en el mismo grupo. "Historias no agrupables quedan explicitamente pendientes." Futuros `planificado/propuestos` y reordenables; solo el próximo requiere refinamiento profundo.

S15 (Refinamiento) Distinguir "confirmado, derivado, opcional, preexistente declarado, no especificado, diferido y delegado técnicamente a ODD." Una pregunta sin respuesta no se convierte en decisión. "Preguntar 1–3 por ronda". Si falta definición crítica: `ready=false` con lista de bloqueos legible; prohibido aprobar/ejecutar hasta resolver o modificar el alcance. "Las definiciones lejanas no bloquean G01." No preguntar detalles técnicos rutinarios.

S16 (Estados) "planificado, en_refinamiento, listo_para_aprobacion, aprobado, en_implementacion, pendiente_revision_humana, en_correcciones, aceptado, bloqueado". Transiciones legales definidas en dominio y aplicadas igual en CLI, MCP, HTTP y UI.

S17 (Dos puertas) Aprobación humana del alcance antes de codificar y aceptación humana tras probar. "El MCP de agentes puede proponer o solicitar esas aprobaciones, no consumirlas en nombre del usuario." "No confiar únicamente en approved_by='human', en un valor pasado por un agente o en el token actual de mutación HTTP como prueba de presencia humana. Explica límites del modelo de amenaza y no simules seguridad fuerte inexistente."

S18 («Ejecuta G01») "Si no está listo, refinar; si no está aprobado, solicitar confirmación; si está aprobado y vigente, entregar exclusivamente esa revisión a ODD."

S19 (Drift) "Cambiar la composición o AC de un grupo aprobado genera revisión nueva; bloquea ejecución hasta reaprobar cuando cambia alcance. No sobrescribir el snapshot anterior."

S20 (Cierre y defectos) ODD reporta "implementado y técnicamente comprobado", el grupo pasa a `pendiente_revision_humana`. Registrar resultado/evidencia por AC y versión. "Si hay defectos, conservar el grupo en_correcciones, vincular criterio fallido, enviar corrección a ODD y repetir revisión. El defecto no se transforma automáticamente en una nueva historia ni otro grupo. Nueva funcionalidad sí pasa por intake o cambio de alcance." "Tras aceptación del usuario, sugerir G02, sin autoejecutarlo."

S21 (Transportes) Operaciones mínimas por CLI, MCP, API y UI. Mantener registro dual MCP y compatibilidad. `rf_task_next` con "política única de elegibilidad en dominio, resultados de bloqueo explicativos y comportamiento legacy preservado". Archivado "seguro, explícito y probado". "No uses rf_task_complete como aceptación del grupo."

S22 (UI) Reutilizar HTML/CSS/JS vanilla, `safe-dom`, protección CSRF y diseño existente. Mantener Kanban, Historial, Métricas y Proyectos; añadir Ideas, Backlog por épicas, Grupos G##, Decisiones `[NO ESPECIFICADO]`, Revisión humana/AC y ejecución relacionada. "Dos vistas del mismo dato, sin duplicar historias." Captura rápida y botón visible de confirmación humana. "no uses innerHTML con datos del usuario."

S23 (Distribución) Conservar binario Bun. "requiere dist/ui junto al ejecutable. O lo empaquetas correctamente como unidad distribuible o documentas explícitamente la pareja binario+assets." Probar rutas desde otro cwd, Windows incluido.

S24 (Markdown) SQLite única fuente de verdad. Exportar resumen del producto, backlog, decisiones y grupos en `.md` versionables, al proyecto correcto. Markdown "es vista/proyección, no segunda base editable". `--check` para exports obsoletos y advertencia antes de sobrescribir cambios manuales. Determinista y separado de `odd/tasks/`.

S25 (Orden) R0 baseline/integridad; R1 detección + modos + captura rápida de ideas + visualización; R2 épicas/historias + agrupación G01..GN + dos vistas; R3 definiciones/preguntas/AC/Ready; R4 aprobación de alcance + gate + handoff ODD; R5 evidencia ODD + revisión humana + defectos + aceptación + siguiente grupo; R6 skills, export y documentación.

S26 (Pruebas mínimas) Los 12 escenarios numerados del encargo: legacy intacto; las cinco situaciones de detección sin proyectos fantasma; captura solo idea; idea extensa con grupos cross-épica; `[NO ESPECIFICADO]` bloquea aprobación y no repregunta; cambios sin pérdida de IDs/AC y snapshot con drift; `rf_task_next` no esquiva autorización; MCP no aprueba ni acepta; ODD terminado ≠ aceptado, defecto → corrección → aceptación, G02 nunca solo; concurrencia/idempotencia/migración sobre fixture; seguridad HTTP y XSS en ideas/historias/decisiones; export determinista sin pisar ODD.

S27 (Entrega) Implementar el código, no solo un plan. No alterar ni borrar datos históricos. Sin servidor externo obligatorio. Informe final con modificaciones, migraciones, contratos, dashboard, rutas de skills, pruebas reales, pendientes e instalación. Si falta trabajo: "deja lo hecho funcionando y verificado, explica lo pendiente y no declares finalizada la transformación."

S28 (Almacenamiento V2 y export legacy, L10) "no quiero ejecutar v1→v6 ni v1→v9 sobre ~/.requireflow/requireflow.db para lanzar RequireFlow 2. No toques, actualices, limpies, comprimas ni reconcilies automáticamente mi base cotidiana antigua." "Quiero conservar el contenido legado en Markdown organizado y arrancar RequireFlow 2 con un almacenamiento nuevo, independiente y claramente configurado." Exportador: snapshot consistente desde el backup verificado o "genera una copia SQLite coherente y de solo lectura sin activar las migraciones del runtime"; recuerda que la base usa WAL, "copiar solo el archivo .db no basta". Incluye "nombre, descripción, ruta original, ID, secciones, tareas y sus IDs, descripciones, tipo, prioridad, estado, fechas, notas, etiquetas, histórico y cualquier otro dato disponible"; si un campo no existía en v1, "indica que no estaba registrado; NO lo inventes". Incluye metadatos y "Verifica que lo exportado coincide con las filas del snapshot". Conserva "el backup original y la base vieja intactos". La exportación "NO implica importar automáticamente ese contenido al nuevo backlog". "No permitas que una variable de entorno o un fallback apunten silenciosamente al archivo v1. Comprueba y muestra qué DB está activa."

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1 | inline | done | evidencia en Log L2/L3 |
| T2 | S2, S10, S11, S12, S22 | inline | done | `92af6c8`, `a5361ea`, `c079766` |
| T3 | S3, S4, S14 | inline | done | `7c1d25e`, `8ec9a9e`, `a90ec58` |
| T4 | S5, S15 | inline | done | `7c1d25e` |
| T5 | S12, S16 | inline | done | `7c1d25e` |
| T6 | S17, S18, S19, S20 | inline | done | `7c1d25e`, `8ec9a9e` |
| T7 | S13, S21 | inline | done | `7c1d25e`, `8ec9a9e` |
| T8 | S24 | inline | pending | — |
| T9 | S9, S23 | inline | done | `8ec9a9e`, esta entrada |
| T10 | S26, S27 | inline | done | `8ec9a9e` |
| T11 | S28 | inline | done | `1d88ab8` |
| T12 | S5, S9 | inline | done | `0c52e74` |

## Log

L1 (user request): encargo completo "PROMPT ÚNICO — Implementar RequireFlow 2 + integración con product-backlog y Gentle AI/ODD". Texto íntegro preservado en la transcripción de la sesión. Restricciones clave: no aprobar automáticamente incrementos, no inventar decisiones funcionales, no sustituir ODD, no borrar datos, no editar documentos ODD, implementar y comprobar.

L2 Baseline verificado (R0). `git@main 629b5f1`, limpio salvo `?? .pi/` y `?? skills/product-backlog/` (entregada por el usuario, 18904 bytes, v2.0.0-beta.1). `bun test` → 125 pass / 0 fail / 454 expects / 21 archivos / 7.34s. `bun run typecheck` → exit 0. `bun run build` → exit 0, `dist/requireflow.exe` 100 MB + `dist/ui` (index.html, app.js, safe-dom.js, styles.css).

L3 Hallazgo que contradice los informes previos. La base viva `~/.requireflow/requireflow.db` está en **schema v1**, no v5: `_schema_migrations` solo tiene la versión 1; no existen `task_cycles`, `root_key`, índice único de historial ni la reconstrucción de historial. Filas reales: 5 proyectos / 22 secciones / 52 tareas / 5 historial. El `requireflow.db` mide 4096 bytes y el contenido vive en el WAL de 2.4 MB. Conclusión: las migraciones 2–5 nunca se aplicaron a la base del usuario; el informe anterior las validó sobre una copia.

L4 Respaldo verificado. `VACUUM INTO` sobre la base viva con conexión de solo lectura → `~/.requireflow/backups/requireflow-pre-r2-2026-10-26T20-22-09.db` (139264 bytes). `PRAGMA integrity_check` = `ok` en origen y copia; conteos idénticos (5/22/52/5).

L5 Ensayo de migración sobre la copia. Copia a un directorio temporal, `runMigrations` v1→v5, resultado: 5 migraciones aplicadas, `integrity_check` = `ok`, 29 ciclos backfilleados de 52 tareas, 5/5 proyectos con `root_key`, FTS responde. **Preservación exacta**: conteos y hashes de IDs de `projects`, `sections`, `tasks` y `history` idénticos antes y después. Los datos basura de pruebas anteriores (`Projects` en Desktop\Projects, `meliodaslosven` en home) se conservan: son datos del usuario, no se borran.

L6 Decisiones técnicas reversibles tomadas (documentadas, sin consulta por ser de implementación).
1. Esquema de planificación en migraciones aditivas v6+; `tasks`/`task_cycles`/`history` no se reconstruyen ni reinterpretan.
2. `work_items` única con `kind IN ('idea','epic','story')`, `CHECK` por columna e invariantes por kind en dominio (no megatabla sin restricciones). Se descarta la FK directa `work_items.increment_id` en favor de una tabla de membresía `increment_items` con historial (`removed_at`), que preserva reagrupaciones y snapshots.
3. `projects.mode` con valores `legacy|product`, default `legacy`. La columna se agrega con `ALTER TABLE` (default no nulo) y el valor se valida en dominio, porque SQLite no permite añadir `CHECK` sin reconstruir la tabla.
4. Se preserva la elegibilidad legacy: tareas sin vínculo siguen siendo seleccionables. El gate nuevo se implementa en T7, no en T2.
5. No se agregan estados a `tasks.status` (requeriría reconstrucción de tabla y rompería CHECK); el bloqueo se expresa por relación y política.
6. `dist/ui` junto al ejecutable se documenta como pareja distribuible; no se cambia el modelo de build en esta unidad.

L7 T2 implementado y verificado (S2, S10, S11, S12, S22). Migración v6 aditiva: `projects.mode`, `work_items` (idea/epic/story con CHECKs), `change_log`, `idempotency_keys`, y columnas nullable `tasks.work_item_id` / `tasks.odd_task_ref` con índice único parcial. Ningún `tasks.status` cambió de significado.

Hallazgo durante el smoke test de CLI: `$HOME` es un repositorio git de dotfiles, así que `findGitRoot` devolvía el home para **cualquier** ruta bajo él. `resolveProjectRoot` y `detectProject` vinculaban entonces cualquier carpeta al proyecto `meliodaslosven` ya registrado. Eso explica el proyecto fantasma `meliodaslosven` y `Projects` que existen en la base real. Corregido con `meaningfulGitRoot()`, que descarta raíces git genéricas (home, escritorio, raíz de disco, temp). Verificado: `init` en un directorio temporal crea el proyecto con el nombre y la raíz correctos; `init` desde HOME falla con exit 1 y no crea nada.

Evidencia observada:
- `bun test` → **167 pass / 0 fail**, 587 expects, 26 archivos.
- `bun run typecheck` → exit 0.
- `bun run build` → exit 0, `dist/requireflow.exe` + `dist/ui` regenerados.
- Binario compilado ejecutado desde un cwd ajeno (`%TEMP%`) con DB aislada: `GET /` → 200 y contiene `viewIdeas` y `projectModeBadge`; `GET /api/health` → 200; `GET /styles.css` → 200 (21 KB).
- Demo CLI con DB temporal: `init --mode product`, `idea`, `backlog` muestran la idea y cero tareas ejecutables.
- Ensayo de migración real v1→v6 sobre copia de la base del usuario: 5 proyectos / 22 secciones / 52 tareas / 5 historial preservados con hashes de IDs idénticos, `integrity_check` ok, 29 ciclos backfilleados.

L8 Contrato añadido en esta unidad (fase 1).
- CLI: `init [--mode <legacy|product>]`, `mode [legacy|product]`, `idea|capture "<texto>" [--key <k>] [--json]`, `backlog [--json]`. `init` y `idea` se niegan a operar en ubicaciones genéricas.
- MCP: `rf_workspace_classify`, `rf_project_set_mode`, `rf_idea_capture`, `rf_backlog_tree` (+ alias). Ninguna herramienta MCP puede aprobar ni aceptar. Hay un test que falla si aparece una.
- HTTP: `GET /api/workspace/classify`, `GET|PATCH /api/projects/:id/mode`, `POST|GET /api/projects/:id/ideas`, `GET /api/projects/:id/planning`, `GET /api/projects/:id/changes`, `GET|PATCH|DELETE /api/backlog/items/:id`. Mutaciones con `expectedVersion`; conflicto → 409 con estado vigente.
- UI: pestaña **Ideas** con captura rápida (Enter guarda, Shift+Enter salto de línea), lista con estado y definición, y badge de modo del proyecto. Render vía `createEl`/texto, sin `innerHTML` con datos del usuario.

L9 Pendiente (no declarado terminado). T3 agrupación automática G01..GN y vistas por épica/grupo; T4 decisiones `[NO ESPECIFICADO]` + Ready; T5 AC estables + revisiones; T6 aprobación humana de alcance, gate de `rf_task_next` y handoff ODD; T7 deuda legacy (`task_cycles` en cascada, snapshot de historial, archivado forzado por defecto, `resolveCurrentProject` todavía auto-crea para comandos legacy distintos de `init`/`idea`); T8 export Markdown; T9 `requireflow-protocol` v2 + registro de skills; T10 verificación final. La base viva del usuario **sigue en v1**: no se migró ni se modificó; la migración v1→v6 está ensayada sobre copia.

L10 (corrección del usuario, fragmentos verbatim). "Ya NO quiero que la skill rellene RequireFlow con el literal [NO ESPECIFICADO], con campos inventados ni con historias parcialmente interpretadas." Flujo: "crea un borrador en la conversación, no en la base"; "pregúntamela inmediatamente"; "persiste valores realmente confirmados en RequireFlow"; "No persistir NO ESPECIFICADO, TODO, TBD, por definir ni valores por defecto supuestos como requisitos aprobados." "CAMBIO EXPLÍCITO RESPECTO AL PLAN ANTERIOR: no quiero ejecutar v1→v6 ni v1→v9 sobre ~/.requireflow/requireflow.db para lanzar RequireFlow 2." "Conserva el contenido legado en Markdown organizado y arranca RequireFlow 2 con un almacenamiento nuevo, independiente y claramente configurado." "No permitas que una variable de entorno o un fallback apunten silenciosamente al archivo v1." "No escribas una supuesta integración que solo genere un prompt para pegar manualmente en otro agente." Este cambio reescribe S5 y agrega S28; reabre T4/T6 y crea T11/T12.

L11 Verificación de esta entrega (reproducida en este turno).
- Baseline real: rama `feat/requireflow-2-product-backlog`, árbol limpio, `bun test` 167/0, typecheck 0.
- Base v1 verificada en solo-lectura: migración 1 únicamente; 5 proyectos / 22 secciones / 52 tareas / 5 historial; `requireflow.db` 4096 bytes con WAL de 2.4 MB.
- Export legacy ejecutado desde la base viva con `VACUUM INTO` en conexión read-only: `legacy-export/requireflow-legacy-export.md` (48415 bytes), `.json` (58463 bytes), 5 archivos por proyecto. Conteos 5/22/52/5, `integrity: ok`, snapshot sha256 `2d185b3f…`, content sha256 `75f28119…`, `verified: yes`.
- Base v1 intacta después del export: mismo tamaño, mismo mtime (22/09/2026), schema v1, sin `task_cycles`.
- V2: `~/.requireflow/v2/requireflow.db`, schema v6, 0 proyectos. `requireflow db` muestra la base activa y la legacy separadas.
- Guard: apuntar `REQUIREFLOW_DB_PATH` a la v1 aborta con exit 1 y un mensaje accionable; verificado también con el binario compilado.
- `bun test` → **179 pass / 0 fail**, 634 expects, 28 archivos. `bun run typecheck` → 0. `bun run build` → 0. Binario desde un cwd ajeno con DB propia: dashboard 200 con `viewIdeas`, `/api/health` 200, DB V2 creada en la ruta override.
- Skills: `requireflow-protocol` v2.0.0 con guarda de modo producto; `product-backlog` v2.1.0 con "preguntar antes de guardar". Registro local `.atl/skill-registry.md` actualizado (archivo ignorado por política del repo, por lo tanto no versionado).
- `legacy-export/` queda en disco y fuera de git (`.gitignore`) porque contiene datos personales de proyectos.

L12 Pendiente tras esta entrega. T3 agrupación automática G01..GN y membresía versionada; T4 preguntas en vivo + validación de promoción (sin persistir marcadores); T5 AC estables y snapshots de alcance; T6 gates efectivos de autorización y elegibilidad compartidos por los cuatro transportes + lectura directa del grupo por ODD; T7 deuda legacy; T8 export Markdown de V2 con `--check`; T9 cierre de skills y UI completa; T10 suite end-to-end de los 17 escenarios. El ciclo «describe idea → pregunta → agrupa → aprueba G01 → ODD → revisa → acepta → G02» **todavía no es ejecutable de punta a punta**: hoy existen captura de ideas, clasificación, modos, aislamiento de almacenamiento y export legacy.

L13 T3–T7, T9 y T10 implementados y verificados (esquema V2 v7).
- Migración v7 aditiva: `increments`, `increment_stories` (con `removed_at` para historial de membresía), `increment_dependencies`, `decisions`, `acceptance_criteria`, `increment_revisions` (snapshot inmutable del alcance aprobado), `increment_reviews`, `review_findings`, `review_results`.
- Dominio: máquina de estados de grupo con transiciones legales; readiness con bloqueos legibles (objetivo, historias refinadas, criterios, dependencias aceptadas); `scope_hash` sobre historias+criterios+decisiones y detección de drift; aprobación solo con actor `human:*`; aceptación solo con actor `human:*` y revisión pendiente; ciclo evidencia → defecto → corrección → nueva revisión → aceptación, conservando ciclos y hallazgos; rechazo de marcadores (`[NO ESPECIFICADO]`, `TODO`, `TBD`, `por definir`) en títulos, descripciones, decisiones y criterios; `proposeGroups` atómico e idempotente por código; `refineIncrement` versionado en un solo paso.
- Elegibilidad única: en modo producto `createTask`, `startTask`, `updateTask→in_progress` y `getNextTask` comparten la misma política. Tareas sin historia, historias no refinadas, grupos no aprobados o con drift quedan bloqueados con razón explícita; el modo legacy conserva el comportamiento clásico. `rf_task_next` devuelve `nextTask` + `blocked[]`.
- Transportes: MCP (`rf_work_item_create`, `rf_work_item_update`, `rf_group_propose|list|get|next|refine|start|evidence|defect|correction`, `rf_ac_add`, `rf_decision_record`, `rf_idea_promote`), HTTP (mismos endpoints + aprobación/aceptación con frase exacta y criterios versionados) y CLI (`group list|show|next|propose|refine|ac|decide|start|evidence|defect|correction|approve|accept`; aprobar/aceptar exige TTY).
- UI: pestaña **Grupos** con las dos vistas (por grupo y por épica), alcance canónico, bloqueos, drift, acciones humanas y modal que exige escribir `APROBAR G01` / `ACEPTAR G01`.
- Seguridad del flujo: **no existe tool MCP de aprobación ni de aceptación**; un test falla si aparece una. El límite se documenta con honestidad: en una herramienta local sin autenticación, el dashboard y la CLI son los canales humanos, y un agente con acceso a shell y a la API podría intentar forjar la frase. La defensa real es que el MCP no expone la operación y que la CLI exige una terminal interactiva.
- Evidencia: `bun test` → **209 pass / 0 fail**, 783 expects, 30 archivos. `bun run typecheck` → 0. `bun run build` → 0 (270 módulos). E2E HTTP de 15 pasos: idea rápida sin tarea → épicas/historias → propuesta G01/G02/G03 cross-épica → refinamiento de G01 → aprobación humana → lectura directa → G02 bloqueado → tarea sin historia rechazada → inicio + evidencia → `pendiente_revision_humana` → defecto → corrección (ciclo 2) → aceptación → G02 siguiente sin ejecutar.
- Corrección de un test preexistente dependiente de la hora UTC (fallaba antes de las 02:00) y del contrato de `rf_task_next`, ambos documentados en el commit correspondiente.

L14 Pendiente. T8: export Markdown determinista del backlog V2 con `--check` y manifiesto (el export legacy ya existe). Limitaciones abiertas: (a) la confirmación humana no es criptográfica — es un canal local con frase y TTY, no autenticación fuerte; (b) `resolveCurrentProject` sigue auto-creando proyecto para comandos legacy distintos de `init`/`idea`; (c) el registro `.atl/skill-registry.md` es local por política del repo; (d) no se verificó el descubrimiento de skills en un cliente externo, solo en el entorno de este agente.
