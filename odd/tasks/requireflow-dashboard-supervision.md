# RequireFlow 2 — supervision-first dashboard

Repository: `C:\Users\meliodaslosven\Desktop\Projects\Requireflow` (branch `feat/requireflow-2-product-backlog`).
Objective: turn the web dashboard into a panel for observing, understanding, reviewing and approving the backlog that `product-backlog` and MCP already organise. Manual editing becomes an optional mode, never the main experience.
No domain redesign, no methodology change, no new approval path. Delivery strategy: `ask-on-risk`. Runner: `bun test`, `tsc --noEmit`, `bun run build`.

## Specs

- **S1 — Default experience is supervision.** Opening the dashboard shows projects, the selected project backlog, groups G01–GN, their state and dependencies. Manual creation forms must not dominate the first screen.
- **S2 — Project overview.** The project view shows: existing epics, functional groups, their state, dependencies, acceptance criteria count, review/implementation status and why a group cannot be executed.
- **S3 — Group cards.** Each group shows `G01 — Crear, compartir y abrir una carta`-style code+name, status, dependencies and counts; navigation between groups is one click.
- **S4 — Group detail.** The detail must expose: goal, experience description, linked stories with identifiers, epic origin of each story, full acceptance criteria text, relevant decisions, dependencies, out of scope, pending functional doubts, current and approved revision, implementation evidence, defects and corrections, and human review state.
- **S5 — Criteria are readable and traceable.** Criteria show their full text, the story they belong to, and status `active | superseded | retired`, preserving superseded/retired history.
- **S6 — Two product perspectives without duplicated data.** `Producto → Grupos → Historias → Criterios` and `Producto → Épicas → Historias → Grupos donde participan`, built from the same payloads.
- **S7 — Manual editing is optional and secondary.** A clearly separated edit mode exposes only operations the domain already supports (refine group, update story, add/supersede/retire criterion, record decision). Operations that do not exist must be stated, not simulated. Every scope-affecting edit must send `expectedVersion` and respect drift/new approval.
- **S8 — Human gates stay human and easy to find.** Approve scope, review evidence, report a defect, request correction and accept a group remain available; confirmation phrases `APROBAR G01` / `ACEPTAR G01` are unchanged; no automatic approval.
- **S9 — States are distinguishable.** `planificado`, `en_refinamiento`, `listo_para_aprobacion`, `aprobado`, `en_implementacion`, `pendiente_revision_humana`, `en_correcciones`, `aceptado`, `bloqueado` have distinct labels and colours; the reason a group cannot run is visible.
- **S10 — Visual quality and access.** Clear hierarchy, consistent components, readable typography, responsive at mobile width, keyboard focus visible, understandable empty states, progressive disclosure (summary first, technical detail on demand).
- **S11 — Preserve existing functionality.** Kanban, ideas, backlog, history, metrics and project manager keep working. No existing endpoint is removed.
- **S12 — Real visual verification.** The updated dashboard runs on `127.0.0.1` on a free port and is checked with a real browser: project list, G01–G05, G01 detail, stories/criteria, dependencies, approval/review controls and mobile presentation.

### Found defects (fixed inside this feature)

- The human confirmation modal never appears: `askHumanConfirmation` sets `class="active"` while the CSS only shows `.modal-backdrop.open`, so approve/accept cannot complete from the UI.
- The "Por épica" list is not hidden when switching back to "Por grupo" because `.groups-list` `display` overrides the `hidden` attribute.

## Tasks

| ID | Specs | Route | Status | Evidence |
| -- | ----- | ----- | ------ | -------- |
| T1 | S8, S11 | inline | done | modal uses `.open` (was `.active`); `[hidden]` rule restores the epic-list toggle |
| T2 | S1, S2, S9 | inline | done | `viewOverview` is the default tab; summary, status strip, group cards, executability reason |
| T3 | S3, S4, S5, S9 | inline | done | filters, full detail: stories + epic origin, criteria with status text, decisions, exclusions, blockers, reviews, findings, evidence |
| T4 | S6 | inline | done | `Mapa del producto` with "Por grupo" and "Por épica" over the same payloads |
| T5 | S7 | inline | done | edit mode behind `state.editMode`, uses existing PATCH/POST routes with `expectedVersion`, states unavailable operations |
| T6 | S10 | inline | done | new CSS layer, status tokens, focus-visible, 980/560 px breakpoints |
| T7 | S11, S7 | inline | done | `test/ui-dashboard.test.ts` (10 tests); suite 271/271 |
| T8 | S12 | inline | done | real browser: overview, G01–G05, G01 detail, maps, modal, edit panel, 390×844 |

## Log

- **L1 (user request, verbatim):** "Quiero mejorar la interfaz web de RequireFlow para adaptarla a nuestra metodología actual. La función principal de la interfaz será observar, comprender, revisar y aprobar el trabajo organizado automáticamente por el agente. No quiero que la interfaz me obligue a crear manualmente historias, seleccionar grupos, organizar épicas o gestionar tareas técnicas. Esas operaciones deben seguir siendo responsabilidad principal del agente mediante `product-backlog` y MCP. La edición manual debe existir solamente como una capacidad opcional."
- **L2:** Baseline inspected in a real browser (`http://127.0.0.1:4270`, source server). Current UI defaults to the Kanban board; the groups tab exists with a list and a narrow detail that omits criteria status, epic origin, dependencies, evidence, reviews/findings and out-of-scope. It also renders the epics list below the groups list.
- **L3:** HTTP API already exposes everything the optional edit mode needs: `PATCH /api/groups/:id` (refine with `expectedVersion`), `PATCH|DELETE /api/criteria/:id` (supersede/retire), `POST /api/groups/:id/criteria`, `POST /api/groups/:id/decisions`, `PATCH /api/backlog/items/:id`. No domain change is required.
- **L4:** Runtime defect found while rendering reviews: `buildReviewsSection` called `nodes.append(...)` on an array; the section aborted and the whole "Evidencias y revisiones" block disappeared. Fixed to `nodes.push(...)` and verified in the browser (3 review cycles, 2 findings rendered).
- **L5:** Verification observed: `bun test` 271 pass / 0 fail (37 files, including 10 new dashboard tests); `bun run typecheck` exit 0; `bun build --compile` to `dist/requireflow-check` exit 0 and `scripts/bundle-ui.ts` exit 0. The default `bun run build` cannot replace `dist/requireflow.exe` while four MCP servers keep it locked (EPERM); the same compile succeeded to an alternate output and the generated artifact was removed afterwards.
- **L6:** Browser verification at `http://127.0.0.1:4270` (source server, local only): overview with 5 group cards and status strip; G01–G05 visible; G01 detail with 11 stories, 13 criteria, 7 decisions, 3 review cycles, 2 findings; both map perspectives; confirmation modal opens with `ACEPTAR G01` and was cancelled without mutating; edit panel opens behind the optional mode; 390×844 layout stacks without horizontal page overflow. Console: 0 errors after the review-section fix.

