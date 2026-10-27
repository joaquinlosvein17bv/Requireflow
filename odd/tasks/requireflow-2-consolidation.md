# RequireFlow 2 — consolidation of provisional groups, init root and skills

Objective: correct the defects found in a real OpenCode test without rebuilding RequireFlow 2, consolidating provisional group persistence, progressive story registration, decision classification, the RF-V2-01 init defect, and both skills.
Branch: `feat/requireflow-2-product-backlog`. Delivery: work-unit commits on the existing branch; push and PR remain human decisions. Runner: `bun test`. Typecheck: `bun run typecheck`. Build: `bun run build`.

## Specs

S1 (Definitive flow) The reference flow is: "1. Describo una idea completa de software. 2. La skill `product-backlog` identifica épicas, historias, funcionalidades y dependencias. 3. Si una decisión funcional es ambigua, me pregunta antes de registrarla como requisito confirmado. 4. La skill organiza automáticamente todas las funcionalidades conocidas en grupos de experiencias G01, G02, G03... 5. Todos los grupos deben quedar visibles en RequireFlow desde la planificación inicial, incluso cuando los grupos futuros todavía sean provisionales. 6. Se refina detalladamente únicamente el próximo grupo que se desarrollará. 7. Cuando esté suficientemente definido, yo autorizo su alcance mediante RequireFlow. 8. Le digo a Gentle AI: «Revisa RequireFlow y continúa con G01». 9. Gentle AI consulta directamente `rf_group_get`, recupera el alcance autorizado y lo implementa mediante ODD. 10. Al terminar, el grupo queda pendiente de mi revisión. 11. Yo pruebo la experiencia y la acepto o solicito correcciones. 12. El ciclo de correcciones puede repetirse hasta mi aceptación. 13. Después, G02 queda disponible como siguiente grupo, pero no se ejecuta automáticamente."

S2 (Provisional groups) "Los grupos futuros pueden persistirse como propuestas provisionales sin estar completamente refinados." Distinguish: "Idea capturada: texto original sin refinar." "Historia formal confirmada: comportamiento individual suficientemente definido mediante información proporcionada por el usuario." "Grupo provisional: agrupación de funcionalidades conocidas, con un objetivo funcional basado en lo expresamente solicitado. Puede contener historias confirmadas, historias draft permitidas por el dominio o membresías todavía incompletas." "Grupo refinado: alcance, historias, dependencias y criterios necesarios suficientemente definidos." "Grupo aprobado: revisión específica autorizada por el usuario." "No confundas ninguno de estos estados." Names, goals and descriptions must derive only from user-expressed functionality. "No se permite inventar historias, criterios, respuestas, restricciones ni decisiones para completar esos grupos." No `[NO ESPECIFICADO]`, `TODO`, `TBD` or fictitious values as requirements. A pending doubt may coexist with a provisional grouping.

S3 (Domain review) Inspect `rf_group_propose`, `rf_group_refine`, `work_items`, `increments` and relations. If provisional groups with draft stories and incomplete criteria are already allowed, correct mainly the skill. Otherwise make the minimum compatible V2 change without weakening approval. Never modify or migrate SQLite V1.

S4 (Verification of provisional groups) A project must show G01–G04 in the dashboard while G01 is refining and the others are provisional. Their existence must not force answering their questions before G01. No provisional group may execute without refinement and approval.

S5 (Progressive registration) Preserve iterative refinement: detect ambiguity, ask 1–3 questions per round, wait, keep confirmed decisions, update affected stories and dependencies, re-check blocking ambiguities. Never invent answers or auto-select recommendations. "Una historia individual suficientemente definida puede registrarse aunque otras historias del mismo grupo estén pendientes." No need to save all stories simultaneously; the group stays in refinement while blocked. The instruction to create and organize a product authorizes progressive registration; no second authorization per story. This does not authorize approval or execution.

S6 (Essential functionality) "No traslades una funcionalidad central a otro grupo únicamente porque su definición necesite una aclaración." If it is needed for the experience being validated, ask what is missing. Opening decorations stay in G01 while their origin is clarified; the optional carousel may be G02 if functionally coherent. Groups form by complete functional experience, real dependencies, observable value, actor coherence, reasonable size, and central features — not by epic, screen, technology or role alone.

S7 (Decision classification) Distinguish decisions that block the current group, partially affect it, belong exclusively to future groups, or are technical and delegable to ODD. "No conviertas automáticamente una decisión de G03 en un bloqueo de G01." If a real dependency exists, explain which G01 behavior needs it. Reading, claiming, replying and conversing are distinct capabilities. Do not re-ask confirmed reading access. Present consequences and allow other options. Do not demand decisions that do not affect the current increment.

S8 (RF-V2-01) In a folder under an ancestor Git root, `init` must respect the explicitly selected and validated folder. "No debe ser obligatorio inicializar Git dentro de una carpeta para que RequireFlow pueda gestionarla como proyecto independiente." Preserve legitimate subfolder detection and independent Git repositories. On real ambiguity between parent project and independent project, request confirmation instead of creating a phantom. After initializing, verify the registered normalized path matches the requested root; otherwise fail safely. Regression cases: empty folder inside parent Git root; normal folder without Git; independent Git repo; already registered project; real subfolder of a registered project; generic HOME/Desktop/TEMP; mismatch between requested and registered root. Do not modify or delete legitimate projects.

S9 (Regression tests) P01 provisional groups visible via MCP, API and dashboard and not executable/approvable. P02 progressive registration with H001/H002 stored and H003 pending while G01 refines. P03 no invented or placeholder requirements. P04 grouping fidelity for the digital-letters scenario: opening animation and decorations stay in G01 unless explicitly reorganized; optional carousel may be G02; claim and conversations keep dependencies. P05 RF-V2-01 fixed without `git init`. P06 product-mode execution: reject tasks without story or with unapproved group; allow technical tasks linked to stories of an authorized group; preserve legacy. P07 direct `rf_group_get` reading contains goal, stories, dependencies, decisions, criteria, status, revision and allowed action; no manual handoff document. P08 review/correction cycles preserve defects, criteria and evidence; never auto-accept; accepting G01 does not execute G02.

S10 (product-backlog v2.3.0) Modify the existing `skills/product-backlog/SKILL.md`, no third skill. Preserve quick capture, iterative questions, no invented requirements, epics/stories, automatic grouping, stable IDs, acceptance criteria, approved versions, change management, iterative corrections, human approval and acceptance. Remove contradictions and add the new rules. Remove any instruction requiring a manual autonomous handoff package: the flow is the user says "«Revisa RequireFlow y continúa con G01»", the agent reads `rf_group_get` and continues with ODD if authorized. RequireFlow keeps stories, groups, decisions, criteria, reviews and human acceptance; ODD keeps its own documents, specs and technical tasks. Update response formats.

S11 (requireflow-protocol v2.2.0) Modify `skills/requireflow-protocol/SKILL.md`. Keep the split: product-backlog plans; requireflow-protocol executes. State unambiguously: "Está prohibido utilizar `rf_task_add` para capturar ideas, crear historias funcionales o saltarse una aprobación." It may register technical execution units only when linked to a valid story, that story belongs to an authorized group, the approved revision is current, the domain confirms eligibility, and ODD's internal work is not duplicated. A functional story is not a technical task; completing a technical task never accepts a story or group. Keep direct `rf_group_get`, respect `canExecute`, `nextAction`, `drifted`, dependencies and blockers; never use legacy tasks to bypass approval. After ODD, the group is pending human review; a reported defect returns it to corrections; no automatic acceptance from green tests.

S12 (Safety and compatibility) Do not modify or migrate SQLite V1 (`~/.requireflow/requireflow.db`). V2 remains independent. Internal V2 migrations are allowed only if indispensable, after a consistent backup and on an isolated copy. Preserve legacy mode, product mode, CLI, MCP, dashboard, history, metrics, deterministic Markdown export, human review, concurrency control, approved snapshots and correction cycles. Do not replace the global binary without authorization. Do not change unrelated OpenCode configuration.

S13 (Delivery report) Report reproduced defects and causes, implemented corrections, modified files, product-backlog v2.3.0 changes, requireflow-protocol v2.2.0 changes, domain/MCP/CLI/API/dashboard changes if any, real test/typecheck/build results, commits, G01–G04 persistence proof, RF-V2-01 verification, pending limitations, and instructions to repeat the OpenCode test. Never declare a problem fixed without evidence.

## Tasks

T1 Reproduce RF-V2-01 with a failing regression test and record observed behavior. (S8, S9-P05) — done (RED: `test/init-root.test.ts` failed on missing `initializeProject`)
T2 Fix `init` root selection, safe post-init verification and ambiguity handling. (S8) — done (GREEN: 9/9)
T3 Review and harden implicit MCP project resolution so it cannot create a phantom project. (S8) — done (`resolveProjectId` now uses `detectProject`)
T4 Rewrite `skills/product-backlog/SKILL.md` to v2.3.0. (S1, S2, S5, S6, S7, S10) — done
T5 Rewrite `skills/requireflow-protocol/SKILL.md` to v2.2.0. (S11) — done
T6 Add regression tests P01–P08. (S9) — done (`test/consolidation.test.ts`, 8 tests)
T7 Run `bun test`, `bun run typecheck`, `bun run build`. (S13) — tests and typecheck done; canonical build blocked by the running MCP (EPERM), alternate compile verified
T8 Verify the compiled binary and MCP against an isolated V2 database. (S4, S13) — done
T9 Commit coherent work units. (S13) — done: `81d78be`, `48003cc`, `f3bf7ce`
T10 Produce the final evidence report. (S13) — done in the final response

## Log

L1 (user request, verbatim):

# CORRECCIÓN Y CONSOLIDACIÓN DE REQUIREFLOW 2

Quiero que realices una corrección integral, pero focalizada, de RequireFlow 2 y de sus dos skills:

- `skills/product-backlog/SKILL.md` — actualmente v2.2.0.
- `skills/requireflow-protocol/SKILL.md` — actualmente v2.1.0.

Ya existe una implementación funcional de RequireFlow 2 con SQLite V2, MCP, CLI, dashboard, agrupaciones G01–GN, criterios de aceptación, revisiones, aprobación humana, integración con ODD y exportación Markdown.

**NO quiero reconstruir RequireFlow desde cero ni reemplazar su arquitectura actual.**

Quiero corregir los problemas detectados durante una prueba real con OpenCode y consolidar el comportamiento que hemos definido.

Trabaja utilizando Gentle AI y ODD. Puedes implementar, ejecutar pruebas y realizar commits sin solicitar autorización por cada tarea técnica ordinaria.

Detente únicamente ante decisiones funcionales importantes no definidas, operaciones destructivas o acciones que puedan afectar mis datos reales.

---

## 1. Objetivo funcional definitivo

El funcionamiento que quiero conseguir es:

1. Describo una idea completa de software.
2. La skill `product-backlog` identifica épicas, historias, funcionalidades y dependencias.
3. Si una decisión funcional es ambigua, me pregunta antes de registrarla como requisito confirmado.
4. La skill organiza automáticamente todas las funcionalidades conocidas en grupos de experiencias G01, G02, G03...
5. Todos los grupos deben quedar visibles en RequireFlow desde la planificación inicial, incluso cuando los grupos futuros todavía sean provisionales.
6. Se refina detalladamente únicamente el próximo grupo que se desarrollará.
7. Cuando esté suficientemente definido, yo autorizo su alcance mediante RequireFlow.
8. Le digo a Gentle AI: «Revisa RequireFlow y continúa con G01».
9. Gentle AI consulta directamente `rf_group_get`, recupera el alcance autorizado y lo implementa mediante ODD.
10. Al terminar, el grupo queda pendiente de mi revisión.
11. Yo pruebo la experiencia y la acepto o solicito correcciones.
12. El ciclo de correcciones puede repetirse hasta mi aceptación.
13. Después, G02 queda disponible como siguiente grupo, pero no se ejecuta automáticamente.

Este flujo es la referencia principal de todas las correcciones.

---

## 2. CORRECCIÓN PRINCIPAL: grupos provisionales persistentes

Actualmente existe una contradicción en `product-backlog`.

La skill indica que debe proponer todos los grupos funcionales iniciales, pero también recomienda mantener fuera del backlog estructurado las funcionalidades futuras que todavía necesitan aclaraciones.

Esto ha provocado que, durante la prueba real, G02–G04 permanezcan únicamente en la conversación y no sean visibles en RequireFlow.

Quiero corregir este comportamiento.

### Nueva regla

**Los grupos futuros pueden persistirse como propuestas provisionales sin estar completamente refinados.**

Distingue obligatoriamente:

**Idea capturada:** texto original sin refinar.

**Historia formal confirmada:** comportamiento individual suficientemente definido mediante información proporcionada por el usuario.

**Grupo provisional:** agrupación de funcionalidades conocidas, con un objetivo funcional basado en lo expresamente solicitado. Puede contener historias confirmadas, historias draft permitidas por el dominio o membresías todavía incompletas.

**Grupo refinado:** alcance, historias, dependencias y criterios necesarios suficientemente definidos.

**Grupo aprobado:** revisión específica autorizada por el usuario.

No confundas ninguno de estos estados.

### Comportamiento esperado

Si describo una aplicación que tiene cuatro experiencias principales, la skill debe poder crear y mostrar:

- G01 — Crear, compartir y abrir una carta.
- G02 — Explorar fotografías.
- G03 — Reclamar y responder cartas.
- G04 — Consultar conversaciones.

Aunque G02–G04 todavía requieran decisiones futuras.

Los nombres, objetivos y descripciones persistidos deben derivarse únicamente de funcionalidades que yo haya expresado.

**No se permite inventar historias, criterios, respuestas, restricciones ni decisiones para completar esos grupos.**

Cuando falten detalles, simplemente no los presentes como confirmados.

No guardes `[NO ESPECIFICADO]`, `TODO`, `TBD` ni valores ficticios como requisitos.

Una duda puede seguir pendiente en la conversación sin impedir que exista una agrupación provisional basada en información conocida.

### Revisión del dominio

Inspecciona los contratos actuales de `rf_group_propose`, `rf_group_refine`, `work_items`, `increments` y sus relaciones.

Comprueba si ya permiten registrar grupos provisionales con historias draft o sin criterios completos.

Si lo permiten, corrige principalmente la skill.

Si no lo permiten, realiza el cambio mínimo, compatible con el esquema V2 existente, para admitir esa situación sin debilitar las restricciones de aprobación.

No modifiques ni migres SQLite V1.

### Verificación obligatoria

Un proyecto debe poder mostrar G01–G04 en el dashboard mientras G01 está en refinamiento y los otros grupos permanecen provisionales.

La existencia de G02–G04 no debe obligarme a responder todas sus preguntas antes de desarrollar G01.

Ningún grupo provisional puede ejecutarse sin pasar por refinamiento y aprobación.

---

## 3. CORRECCIÓN: preguntar antes de guardar, pero sin bloquear historias independientes

Quiero conservar íntegramente el refinamiento conversacional iterativo.

El agente debe:

1. Detectar una ambigüedad funcional relevante.
2. Formular entre una y tres preguntas por ronda.
3. Esperar mi respuesta.
4. Conservar la decisión confirmada.
5. Actualizar las historias y dependencias afectadas.
6. Comprobar si quedan ambigüedades bloqueantes.
7. Continuar preguntando cuando corresponda.

**No debe inventar respuestas ni escoger automáticamente sus propias recomendaciones.**

Sin embargo, debe distinguir la completitud de una historia de la completitud de un grupo.

### Regla nueva

Una historia individual suficientemente definida puede registrarse aunque otras historias del mismo grupo estén pendientes.

No es necesario esperar hasta que todas las historias estén completas para guardar cualquier parte del Product Backlog.

Tampoco es necesario guardar todas las historias simultáneamente.

El grupo permanecerá en refinamiento mientras tenga bloqueos funcionales.

### Autorización para registrar

Cuando ya he solicitado crear y organizar un producto en RequireFlow, esa instrucción autoriza registrar progresivamente las unidades confirmadas.

No necesito dar una segunda autorización para guardar cada historia individual.

Esto no autoriza aprobar ni ejecutar el grupo.

### Preservación del origen

Conserva siempre:

- Descripción original del usuario.
- Funcionalidades explícitamente solicitadas.
- Decisiones respondidas.
- Procedencia de cada historia.
- Identificadores estables.
- Relaciones entre épicas, historias y grupos.

No confundas el estado interno `definition: unspecified` de una idea capturada con un requisito formal incompleto.

La idea original puede conservarse sin refinar.

---

## 4. CORRECCIÓN: no separar funcionalidades esenciales para evitar preguntas

Durante la prueba de cartas digitales, el agente movió inicialmente la lluvia de emojis, stickers o fotografías a un grupo posterior, pese a que formaba parte de la experiencia de apertura descrita por el usuario.

Quiero una regla explícita:

**No traslades una funcionalidad central a otro grupo únicamente porque su definición necesite una aclaración.**

Si la funcionalidad es necesaria para la experiencia que se quiere validar, pregunta lo que falte.

Por ejemplo:

Si G01 consiste en crear, compartir y abrir una carta con una animación y elementos decorativos, esos elementos deben mantenerse en el alcance candidato de G01 mientras se aclara su origen.

Un carrusel opcional puede ubicarse en G02 si constituye una experiencia adicional y esa separación es funcionalmente coherente.

La skill puede recomendar una división diferente, pero debe explicar el impacto y no sustituir silenciosamente la intención original del usuario.

### Agrupación correcta

Los grupos se forman según:

- Experiencia funcional completa.
- Dependencias reales.
- Valor observable.
- Coherencia entre actores.
- Complejidad y tamaño razonables.
- Características centrales de la experiencia solicitada.

No agrupar exclusivamente por épica, pantalla, tecnología o rol.

Una misma experiencia puede incluir historias de distintas épicas.

---

## 5. CORRECCIÓN: evitar preguntas repetidas y falsas dependencias

El agente ya sabe preguntar, pero debe mejorar su clasificación de decisiones.

Distingue:

1. Decisiones que bloquean el grupo actual.
2. Decisiones que afectan parcialmente el grupo actual.
3. Decisiones exclusivas de grupos futuros.
4. Decisiones técnicas delegables a ODD.

No conviertas automáticamente una decisión de G03 en un bloqueo de G01.

Si realmente existe una dependencia, explica concretamente qué comportamiento de G01 necesita esa respuesta.

### Ejemplo: cartas digitales

Distingue:

- Leer una carta mediante enlace y pregunta.
- Reclamarla y asociarla a una cuenta.
- Responderla.
- Mantener una conversación.

Son capacidades relacionadas, pero no son el mismo permiso ni la misma decisión funcional.

Si una persona ya confirmó que puede leer una carta sin cuenta, no vuelvas a preguntarle si necesita registrarse para leerla.

Si queda pendiente cómo demostrar la identidad de quien reclama, examina si eso bloquea realmente G01 o si puede resolverse al refinar G03.

Cuando existan distintas alternativas, presenta consecuencias y permite al usuario elegir otra opción.

No exijas resolver decisiones que no afectan el incremento actual.

---

## 6. CORRECCIÓN REAL DE REQUIREFLOW: proyecto fantasma por Git root ancestro

Durante la prueba real se detectó el defecto RF-V2-01.

### Contexto

Carpeta solicitada:

`C:\Users\meliodaslosven\Desktop\Projects\CartasDigitales-Test`

Un repositorio Git ancestro se encuentra en:

`C:\Users\meliodaslosven\Desktop\Projects`

`rf_workspace_classify` identificó correctamente la carpeta de prueba como `empty-new`.

Sin embargo, al ejecutar `requireflow init --mode product`, el sistema resolvió el Git root padre y creó un proyecto incorrecto llamado `Projects`.

El agente tuvo que utilizar `git init` dentro de la carpeta de prueba para evitar el problema.

**Ese workaround no es aceptable como solución definitiva.**

### Corrección requerida

Inspecciona `resolveProjectRoot`, `resolveCurrentProject`, `classifyWorkspace`, `init` y cualquier función relacionada con detección de raíces y proyectos.

Haz que la inicialización respete la carpeta explícitamente seleccionada y validada para un proyecto nuevo.

No debe ser obligatorio inicializar Git dentro de una carpeta para que RequireFlow pueda gestionarla como proyecto independiente.

Mantén el reconocimiento legítimo de subcarpetas pertenecientes a proyectos registrados y de repositorios Git independientes.

Si existe ambigüedad real entre utilizar un proyecto padre o crear uno independiente, solicita confirmación en lugar de crear un proyecto fantasma.

Después de inicializar, comprueba que la ruta efectivamente registrada coincide con la raíz solicitada, normalizada de acuerdo con las reglas de Windows.

Si no coincide, la operación debe fallar de forma segura.

### Pruebas de regresión

Incluye casos para:

- Carpeta vacía dentro de un Git root padre.
- Carpeta normal sin repositorio Git.
- Repositorio Git independiente.
- Proyecto previamente registrado.
- Subcarpeta que realmente pertenece a un proyecto registrado.
- Directorio genérico como HOME, Desktop o TEMP.
- Intento de crear un proyecto con una raíz diferente a la solicitada.

No modifiques registros legítimos de otros proyectos ni elimines proyectos sin necesidad.

---

## 7. ACTUALIZAR `product-backlog` A v2.3.0

Modifica el archivo existente:

`skills/product-backlog/SKILL.md`

No crees una tercera skill.

Conserva todas las instrucciones útiles de v2.2.0, especialmente:

- Captura rápida.
- Preguntas iterativas.
- Prohibición de inventar requisitos.
- Organización por épicas e historias.
- Agrupación automática.
- Identificadores estables.
- Criterios de aceptación.
- Versiones aprobadas.
- Gestión de cambios.
- Correcciones iterativas.
- Aprobación y aceptación humana.

Corrige las contradicciones detectadas e incorpora las reglas nuevas.

### Traspaso a ODD

Elimina cualquier instrucción que obligue a preparar o copiar manualmente un paquete autónomo de traspaso.

Nuestro flujo definitivo es:

El usuario dice:

**«Revisa RequireFlow y continúa con G01».**

El agente consulta `rf_group_get`, obtiene el alcance y las condiciones de ejecución y continúa mediante ODD si el grupo está autorizado.

El resumen funcional puede presentarse al usuario, pero no se necesita generar un documento especial para que el agente pueda continuar.

ODD conserva sus propios documentos, especificaciones y tareas técnicas.

RequireFlow conserva historias, grupos, decisiones, criterios, revisiones y aceptación humana.

Actualiza también los formatos de respuesta para eliminar referencias contradictorias al traspaso manual.

---

## 8. ACTUALIZAR `requireflow-protocol` A v2.2.0

Modifica:

`skills/requireflow-protocol/SKILL.md`

Conserva la separación de responsabilidades:

`product-backlog` es responsable de planificar.

`requireflow-protocol` es responsable de la ejecución técnica.

### Aclarar `rf_task_add`

Actualmente puede interpretarse que `rf_task_add` está totalmente prohibido en modo producto.

Redacta una regla inequívoca:

**Está prohibido utilizar `rf_task_add` para capturar ideas, crear historias funcionales o saltarse una aprobación.**

Pero puede utilizarse para registrar unidades de ejecución técnica cuando:

- La tarea está vinculada a una historia válida.
- La historia pertenece a un grupo autorizado.
- La revisión aprobada está vigente.
- El dominio confirma que la tarea es elegible.
- No se duplica innecesariamente el trabajo interno de ODD.

Una historia funcional no es una tarea técnica.

Terminar una tarea técnica tampoco significa aceptar una historia o un grupo.

### Lectura directa por ODD

Mantén la consulta mediante `rf_group_get`.

El agente debe respetar `canExecute`, `nextAction`, `drifted`, dependencias y bloqueos.

No debe usar tareas legacy para eludir la autorización de grupos.

### Estado de revisión

Cuando ODD termina, el grupo pasa a revisión humana.

Si reporto un defecto, vuelve a correcciones.

Ningún grupo se acepta automáticamente porque los tests hayan pasado.

---

## 9. Preservar seguridad, compatibilidad y datos

No modifiques ni migres SQLite V1.

La base antigua:

`~/.requireflow/requireflow.db`

debe permanecer intacta.

La base nueva V2 seguirá siendo independiente.

Puedes realizar migraciones internas de V2 si son indispensables para almacenar grupos provisionales correctamente.

Antes de cualquier migración V2, realiza un respaldo consistente y prueba el cambio sobre una copia aislada.

Conserva:

- Modo legacy.
- Modo product.
- CLI.
- MCP.
- Dashboard.
- Historial.
- Métricas.
- Exportación Markdown determinista.
- Revisión humana.
- Control de concurrencia.
- Snapshots aprobados.
- Ciclos de corrección.

No reemplaces el binario global antiguo sin autorización.

No cambies configuraciones de OpenCode que no sean necesarias para la prueba.

---

## 10. Pruebas obligatorias

Además de ejecutar la suite existente, agrega pruebas para las correcciones.

### P01 — Grupos futuros visibles

Crear un proyecto con G01–G04.

G01 contiene historias confirmadas y otras en refinamiento.

G02–G04 son propuestas provisionales basadas en funcionalidades expresamente proporcionadas.

Los cuatro grupos deben ser visibles mediante MCP, API y dashboard.

Los futuros no pueden ejecutarse ni aprobarse mientras estén incompletos.

### P02 — Registro progresivo

Registrar H001 y H002, ambas confirmadas.

Mantener H003 pendiente por una ambigüedad.

Comprobar que H001 y H002 permanecen almacenadas y G01 sigue en refinamiento.

No exigir registrar todas las historias simultáneamente.

### P03 — No persistir información inventada

El agente recibe una historia ambigua.

Debe preguntar, no inventar una respuesta ni guardar un marcador como requisito confirmado.

Los grupos provisionales pueden guardar únicamente objetivos y capacidades que estén suficientemente sustentados por el usuario.

### P04 — Fidelidad de la agrupación

Usar el escenario de cartas digitales.

Comprobar que la animación y las decoraciones centrales permanecen en G01 salvo una decisión explícita de reorganización.

El carrusel opcional puede quedar en G02.

La reclamación y las conversaciones deben mantener sus dependencias.

### P05 — Corrección del proyecto fantasma

Reproducir RF-V2-01 y comprobar que `init` registra la carpeta correcta sin necesitar `git init`.

Verificar que las demás situaciones de workspace siguen funcionando.

### P06 — Ejecución técnica autorizada

En modo producto, rechazar tareas sin historia o con un grupo no aprobado.

Permitir tareas técnicas vinculadas a historias de un grupo autorizado.

Preservar compatibilidad con modo legacy.

### P07 — Lectura directa por ODD

Consultar G01 mediante `rf_group_get`.

Verificar que contiene objetivo, historias, dependencias, decisiones, criterios, estado, revisión y acción permitida.

No exigir un documento de traspaso manual.

### P08 — Revisión y corrección

Verificar que los defectos, criterios y evidencias sobreviven a múltiples ciclos.

No aceptar automáticamente un grupo.

No ejecutar G02 cuando se acepta G01.

---

## 11. Proceso de implementación

Trabaja sobre la rama existente de RequireFlow 2.

Primero lee el código y las dos skills actuales.

Después:

1. Reproduce los defectos identificados.
2. Determina qué problemas son exclusivamente instrucciones y cuáles necesitan cambios de dominio.
3. Implementa la corrección mínima suficiente.
4. Actualiza las dos skills.
5. Agrega pruebas de regresión.
6. Ejecuta tests, typecheck y build.
7. Comprueba el binario compilado y el MCP nuevo.
8. Verifica que no haya incompatibilidades con el flujo ODD.
9. Registra los cambios mediante commits coherentes.

Evita introducir sistemas adicionales, rediseñar la arquitectura o agregar funcionalidades que no estén relacionadas con estas correcciones.

No me entregues solamente una propuesta: quiero implementación y verificación reales.

---

## 12. Entrega final

Cuando termines, muéstrame:

1. Defectos reproducidos y sus causas.
2. Correcciones implementadas.
3. Archivos modificados.
4. Cambios en `product-backlog` v2.3.0.
5. Cambios en `requireflow-protocol` v2.2.0.
6. Cambios en dominio, MCP, CLI, API o dashboard, si fueron necesarios.
7. Resultados reales de tests, typecheck y build.
8. Commits realizados.
9. Pruebas de persistencia de G01–G04.
10. Verificación de RF-V2-01.
11. Limitaciones pendientes, si existen.
12. Instrucciones para repetir la prueba con OpenCode.

No declares corregido un problema sin evidencia.

No modifiques SQLite V1 ni mis proyectos legítimos.

**Criterio final de éxito:**

Debo poder describir mi aplicación, responder únicamente las ambigüedades relevantes y encontrar en RequireFlow todos los grupos funcionales conocidos, incluidos los futuros provisionales, sin requisitos inventados.

Después debo poder refinar y aprobar G01, pedir a Gentle AI que lo consulte directamente, implementarlo mediante ODD, probarlo, solicitar correcciones y aceptarlo sin perder la trazabilidad.

Ese es el comportamiento que debes garantizar.

L2 (2026-10-27) Implementation evidence:

- Domain review: `proposeGroups` already creates `planificado` groups with optional `goal`, `storyIds` and `acceptanceCriteria`; `incrementReadiness`, `canExecute` and the approval gate already block provisional groups. No V2 schema change or migration was needed.
- RF-V2-01 reproduced: `init` called `resolveCurrentProject` → `resolveProjectRoot`, which follows the ancestor Git root. RED test failed because `initializeProject` did not exist. Added `initializeProject` with explicit-root, empty-new, nested-repo and ambiguity rules plus post-init normalized-root verification. GREEN: 9/9.
- Extra root-detection fix: `isAmbiguousLocation` now compares real paths, so a Windows 8.3 short name (`C:\Users\MELIOD~1`) cannot turn the home directory into a product root.
- MCP `resolveProjectId` no longer auto-creates a project when `projectId` is omitted; it resolves only an existing project and fails loudly otherwise.
- Skills: `product-backlog` v2.3.0 and `requireflow-protocol` v2.2.0.
- Tests: `bun test` → 238 pass, 0 fail; `bun run typecheck` → exit 0.
- Build: `bun run build` succeeded. The running OpenCode MCP held `dist/requireflow.exe`, so the old file was renamed to `dist/requireflow.old.exe` (still in use until OpenCode restarts); the canonical `dist/requireflow.exe` now contains the new build and the UI bundle was refreshed.
- Binary verification: isolated V2 DB in `%TEMP%`; `init --mode product` inside an empty folder under an ancestor `.git` registered the child folder, schema v7, 1 project, legacy v1 untouched. A non-empty child failed without `--root` and succeeded with `--root .`.
- Canonical binary MCP verification: `dist/requireflow.exe mcp` registered `rf_group_list/get/next/propose/refine/start/evidence/defect/correction`; `rf_project_list` returned 1 project; `rf_group_list` returned 0 groups.
- Commits: `81d78be` fix(init), `48003cc` fix(mcp) + P01–P08 tests, `f3bf7ce` docs(skills) + this feature document.

