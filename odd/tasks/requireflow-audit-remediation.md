# RequireFlow — Audit Remediation

Objective: verify and fix the 24 consolidated audit findings (RF-01..RF-24) at root cause, with RED→GREEN tests, versioned migrations, one commit + push per fix.
Branch: `main` (explicit user instruction: one commit and one push per fix). Delivery: direct to `main`, no PR. Test runner: `bun test`. Typecheck: `bunx tsc --noEmit`. Build: `bun run build`.
Baseline before any change: 18 tests pass / 0 fail, `tsc --noEmit` fails on config (TS5102), 5 projects / 22 sections / 52 tasks / 5 history rows in `~/.requireflow/requireflow.db`, backup at `~/.requireflow/backups/requireflow-pre-audit-20261024-094951.db`.

## Specs

S1 (RF-01) Project identity must be a normalized, stable root path, not `name`. Two distinct repos named `backend` must produce independent projects and never share tasks. `name` stays a display label. Review `UNIQUE` indexes. Handle Windows separators, case, and equivalent paths. Migration must preserve every existing row. Pre-existing collisions must be detected, never split automatically without evidence.
Acceptance (verbatim): "dos repositorios distintos llamados `backend` deben generar proyectos independientes y nunca compartir tareas."

S2 (RF-02) An explicit `projectId` that does not exist must return a clear error; never fall back to another project. Automatic resolution only when no id is supplied. Consistent across every MCP tool that accepts a project.
Acceptance (verbatim): "un identificador inválido debe fallar sin crear ni modificar tareas en ningún proyecto."

S3 (RF-03) Remove stored XSS in the dashboard: inventory every dynamic render point, prefer `textContent`/safe node creation, escape legitimate dynamic HTML, validate colors against an allowlist, and ensure data entered via MCP/API cannot become executable code.
Acceptance (verbatim): "introducir valores adversariales como `<img src=x onerror=alert(1)>` y comprobar en un navegador real que no ejecutan JavaScript."

S4 (RF-04) Restrict origins/hosts to legitimate clients, protect against DNS rebinding and cross-site requests, and design a verifiable protection for destructive operations without breaking CLI/MCP/dashboard. CORS is not authentication.
Acceptance (verbatim): "solicitudes autorizadas funcionan; solicitudes de orígenes no autorizados y accesos no autenticados protegidos fallan. Verificar los escenarios desde navegador y cliente HTTP."

S5 (RF-05) History must be preserved when tasks are deleted. Explicit retention policy (`ON DELETE SET NULL` and/or independent snapshots), keep enough data to identify the project and reconstruct activity, adapt queries/FTS/metrics, ship a safe migration.
Acceptance (verbatim): "completar, archivar y eliminar una tarea no debe destruir su registro histórico."

S6 (RF-06) A task may only reference a section of its own project, on create, update, and move. Consider DB-level reinforcement. Review other cross-project links.
Acceptance (verbatim): "una asignación entre proyectos diferentes debe rechazarse sin efectos secundarios."

S7 (RF-07) `force` is true only when explicitly requested; boolean args parsed correctly; configured thresholds respected; CLI/MCP/HTTP/dashboard semantics unified.
Acceptance (verbatim): "una tarea recién completada no debe archivarse si no alcanzó el umbral y no se solicitó forzar la operación."

S8 (RF-08) Implement the promised automatic archival when the threshold is reached, via a reliable mechanism, without requiring a manual button. Idempotent and concurrency-safe. Document what happens when no process is running.
Acceptance (verbatim): "utilizar un reloj controlado para demostrar que la tarea no se archiva antes del umbral y sí cuando corresponde."

S9 (RF-09) Explicit state machine for `backlog`, `todo`, `in_progress`, `done`, `archived`: legal/illegal transitions, intentional reopenings, which timestamps reset, idempotent repeats, no incoherence between current state and history. Multiple cycles must be modeled explicitly instead of silently overwriting old metrics.
Acceptance (verbatim): "cubrir transiciones normales, repetidas, inválidas y reaperturas."

S10 (RF-10) A task must not get duplicate history rows on re-archive. Choose one-record-per-task or one-per-cycle, enforce it, remove duplicates through transactions/idempotency, and clean pre-existing duplicates without losing legitimate events.
Acceptance (verbatim): "repetir una operación de archivado no crea registros duplicados."

S11 (RF-11) One canonical time representation (UTC ISO 8601). Normalize new writes, migrate existing rows interpreting their origin correctly, fix lead/cycle time, review cross-format SQL comparisons, stop `Math.max(0, ...)` from hiding wrong math, test across timezones.
Acceptance (verbatim): "una tarea de diez minutos debe registrar una duración correcta independientemente de la zona horaria."

S12 (RF-12) Rebuild the dynamic FTS conditions, delete `join(" AND " || "")`, never swallow SQLite exceptions indiscriminately, keep the LIKE fallback only for explicit cases, preserve BM25 ranking.
Acceptance (verbatim): "buscar con y sin `projectId` debe ejecutar correctamente FTS5, con resultados y ordenamiento esperados."

S13 (RF-13) Define formally which states are eligible for "next"; keep MCP, docs and selection logic coherent; respect priority, blocks and position; avoid `null` when eligible tasks exist.
Acceptance (verbatim): "una tarea elegible en backlog debe poder seleccionarse conforme a las reglas definidas."

S14 (RF-14) Separate project resolution from creation; GET must be read-only; explicit write operations create projects; validate supplied paths; arbitrary paths must not create records.
Acceptance (verbatim): "consultar un directorio desconocido no debe modificar el número de proyectos."

S15 (RF-15) `is_directory_linked` must use Git root resolution or normalized root containment, reusing RF-01 identity, so subdirectories resolve to the same project and no duplicate project is offered.
Acceptance (verbatim): "ejecutar desde la raíz y desde `src/domain` debe identificar el mismo proyecto."

S16 (RF-16) Deterministic, consistent ordering with stable tie-breakers; `getNextTask` must not ignore visible board order; `MAX(position)+1` must be transaction-safe; test real MCP concurrency.
Acceptance (verbatim): "reordenar el tablero altera la selección cuando corresponde; las inserciones concurrentes mantienen posiciones coherentes."

S17 (RF-17) One consumer must never close another consumer's connection. Per-path cache or explicit instance management; safe close and release.
Acceptance (verbatim): "dos consumidores utilizando diferentes bases de datos en el mismo proceso no deben invalidarse mutuamente."

S18 (RF-18) Resolve the TypeScript/config incompatibility, keep strict checks, confirm the reported 32 errors, fix them at source without `any`/`@ts-ignore`/relaxation, run `tsc --noEmit`, add typecheck to CI.
Acceptance (verbatim): "typecheck completo con cero errores."

S19 (RF-19) Validate ports, thresholds, numbers and options; reject `NaN`, out-of-range and malformed values; support `--key=value`, `--key value` and boolean flags coherently; allow legitimate negatives; descriptive errors.
Acceptance (verbatim): "entradas inválidas deben fallar limpiamente sin modificar datos ni provocar errores internos inesperados."

S20 (RF-20) Validate JSON bodies, path params and query strings; correct status codes (400/404/409/422/500); no SQLite internals leaked; keep technical logs; bound `page`, `limit`, `days`.
Acceptance (verbatim): "JSON inválido, estados no admitidos y parámetros erróneos deben producir respuestas estables y documentadas."

S21 (RF-21) Single source of truth for UI files, reliable dashboard packaging, no accidental use of another project's UI, works from any cwd, remove duplicates once distribution is stable.
Acceptance (verbatim): "ejecutar el binario desde distintas rutas y verificar que siempre carga la interfaz correcta."

S22 (RF-22) Respect requested windows (dailyTrends must not always return seven days), normalize units/names, remove safe semantic duplication, verify with controlled datasets.
Acceptance (verbatim): "ventanas de 7, 30 y otros periodos deben devolver resultados matemáticamente consistentes."

S23 (RF-23) Demo data fully isolated from real data, no deletes by name, no hardcoded paths, remove confirmed dead code, review the `config` table before removing it, demo operations safe and repeatable.
Acceptance: demo seeding must not touch non-demo projects; residual code removed only where confirmed dead.

S24 (RF-24) Sync README/docs with real behaviour, verify MCP tool contracts, resolve duplicated docs without breaking consumers, add invariant/error/security/concurrency/migration tests, configure CI for tests + typecheck + build.
Acceptance: documentation matches implementation; CI runs tests, typecheck and build.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S18 | inline | done | `1a86026` |
| T2 | S21 | inline | done | `d2b5a6d` |
| T3 | S3 | inline | done | `a0cd96a` |
| T4 | S17 | inline | done | `d3abe2e` |
| T5 | S1, S15 | inline | done | `bde90b9` |
| T6 | S2 | inline | done | `b229c38` |
| T7 | S6 | inline | done | `0a6d480` |
| T8 | S11, S22, S9 | inline | done | `0293ce2` |
| T9 | S9, S10 | inline | done | `fb5d4e5` |
| T10 | S5 | inline | done | `d774703` |
| T11 | S7, S8 | inline | done | `a77ba0e` |
| T12 | S13, S16 | inline | done | `5836501` |
| T13 | S14 | inline | done | `dfd981f` |
| T14 | S4 | inline | done | `3079fbd` |
| T15 | S19 | inline | done | `532f9c3` |
| T16 | S20 | inline | done | `153ae74` |
| T17 | S23 | inline | done | `8484892` |
| T18 | S24 | inline | done | `167f181` |
| T19 | all | inline | done | final report |

## Log

L1 (user request, verbatim excerpts): "Actúa como ingeniero de software senior, arquitecto de sistemas y auditor de seguridad. […] verificar, consolidar y corregir todos los hallazgos, abordando las causas raíz y no simplemente los síntomas." Rules: "Examina el repositorio real antes de modificarlo." / "No consideres correcto el sistema simplemente porque sus 18 tests actuales pasan." / "Conserva los proyectos, tareas, secciones, historial y configuraciones existentes." / "Utiliza migraciones versionadas y respaldos antes de cualquier modificación destructiva del esquema." / "Por cada defecto confirmado, reproduce primero el fallo mediante una prueba automatizada (RED), implementa la corrección y verifica el resultado (GREEN)." / "Trabaja en unidades pequeñas, verificables y con commits independientes cuando corresponda." / "No declares terminada la misión mientras existan errores sin resolver que afecten a las garantías principales del sistema." / "quiero que por cada arreglo hagas un commit y push". Product-decision rule: "Si alguna corrección exige una decisión de producto no especificada, describe las alternativas, adopta la opción compatible y conservadora cuando sea segura y documenta cualquier decisión pendiente." Full original message is preserved in the session transcript.

L2 Baseline (verified, pre-change): `bun test` 18 pass / 0 fail; `bunx tsc --noEmit` → TS5102 `baseUrl` removed (config invalid, zero files typechecked); with a corrected config in a scratch copy: 32 real errors (routes 18, cli 11, mcp 2, history 1). Real DB backed up via `VACUUM INTO` before any migration.

L3 Confirmed by reproduction (see audit transcript): RF-01, RF-02, RF-05, RF-07, RF-08, RF-09, RF-10, RF-11, RF-12, RF-13, RF-14, RF-15, RF-16, RF-17, RF-18, RF-19, RF-20. RF-03 confirmed by inspection: `showToast` and `section.name`/`section.color`/`section_name` are interpolated into `innerHTML` unescaped. RF-04 confirmed: `Access-Control-Allow-Origin: *` on an unauthenticated API with `DELETE /api/projects/:id`. RF-21 confirmed: `public/` is byte-identical to `src/ui/`. RF-22 confirmed: `dailyTrends` hardcodes 7 days. RF-23/RF-24 confirmed by inspection.

L4 Architectural decisions (conservative, documented):
1. External `UNIQUE(name)` was an index, so identity can change with `DROP INDEX` + non-unique index, no table rebuild for projects.
2. `task_cycles` table is the single source of truth for cycle/lead/throughput metrics; `tasks.cycle_time_seconds` is kept as a display cache of the last cycle. Migration backfills one cycle row per already-completed task so no metric is lost and nothing is double counted.
3. `history` stays one row per task (`UNIQUE(task_id)`), with `task_id` nullable and `ON DELETE SET NULL`, plus a `section_name` snapshot.
4. API security model: Host allowlist (rebinding) + Origin allowlist (cross-site) + per-run mutation token bootstrapped from `GET /api/health`, which is origin-restricted. No CORS `*`. The token is not user auth; the real boundary stays the local file. Documented in README.
5. UI files are embedded at build time via text imports; `uiDir` remains an explicit override for tests/dev. `public/` is removed.
6. Auto-archive runs opportunistically (CLI startup + HTTP server interval) because a local-first tool has no daemon; documented in README.
7. Pre-existing identity collisions cannot be split without evidence: the migration records them as warnings (project whose `root_path` no longer exists on disk) and never reassigns tasks.

L5 Final verification (Phase 5): 125 tests pass / 0 fail, typecheck exit 0, build produces dist/requireflow + dist/ui. Compiled binary run from a foreign cwd with a decoy src/ui serves the correct dashboard, 403 without token, 403 with spoofed Host. Real database copy migrated through v5 with all rows and ids preserved, FTS working. Browser pass on the demo dataset: Kanban 4/2/2, 30 trend rows, 5 history rows, zero console errors, stored XSS payloads inert. Report: AUDITORIA_CORRECCIONES_REQUIREFLOW.md.
