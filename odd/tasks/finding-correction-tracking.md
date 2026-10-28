# Finding correction tracking (option A)

Repository: `C:\Users\meliodaslosven\Desktop\Projects\Requireflow` (branch `feat/requireflow-2-product-backlog`).
Objective: distinguish a defect that still needs work, a correction the agent delivered and a correction the human accepted — without rebuilding the schema or inventing historic associations.
Runner: `bun test`, `tsc --noEmit`, `bun run build`.

## Specs

- **S1 — Three visible states.** `pending` (needs work), `correction_delivered` (agent delivered, human has not accepted), `resolved` (human accepted). Internally `review_findings.status` keeps `open | resolved`.
- **S2 — Explicit association only.** `deliverCorrection` accepts `findingIds`. Findings not named stay `pending`; omitting the list marks nothing. No "all open findings" shortcut.
- **S3 — Partial corrections.** A correction can address a subset of findings; the rest remain `pending`.
- **S4 — Rejection returns the defect to work.** `rejectCorrection` marks the specific delivered attempts as `rejected` with actor, date and reason, keeps them in history, and moves the group back to `en_correcciones`. The finding derives back to `pending`.
- **S5 — Acceptance resolves.** Only `acceptIncrement` (human) sets findings to `resolved`; delivered attempts stay visible.
- **S6 — Coherent MCP, API and dashboard.** `rf_group_get` exposes reviews with findings, attempts and the derived state; `GET /api/groups/:id` returns the same shape; the dashboard labels each finding and offers rejection only for delivered corrections.
- **S7 — History preserved.** Attempts are append-only; a new correction adds a row, never rewrites a rejected one.
- **S8 — Historic backfill only with proof.** G01 findings are linked only where the correction-cycle evidence names the delivered work.

## Data model

`review_finding_corrections(id, finding_id, review_id, delivered_at, rejected_at, rejected_by, rejected_reason, status)` with `UNIQUE(finding_id, review_id)`. No `CHECK` change on `review_findings`; migration `8_finding_correction_tracking` is additive.

Derived state: `resolved` if the finding is resolved; `correction_delivered` if any attempt is `delivered`; otherwise `pending`.

## Tasks

| ID | Specs | Status | Evidence |
| -- | ----- | ------ | -------- |
| T1 | S1, S7 | done | migration 8 + derived state helper |
| T2 | S2, S3, S4, S5 | done | `deliverCorrection(findingIds)`, `rejectCorrection`, acceptance unchanged |
| T3 | S6 | done | `getIncrementReviews` in HTTP + `rf_group_get`; dashboard labels and reject control |
| T4 | S2–S5 | done | `test/finding-corrections.test.ts` 7 tests (multiple defects, partial, rejection, acceptance, invalid association, API route) |
| T5 | S8 | done | G01 backfill: navigation finding → cycle 2 evidence (commit 409ccbe); concurrency finding → cycle 3 evidence (commits 2b57cba, 9810873) |

## Log

- **L1 (user requirement, verbatim):** "Puedes mantener internamente `open | resolved` y utilizar información adicional para representar estos estados, evitando reconstruir innecesariamente el esquema. Regla obligatoria: no marques automáticamente todos los hallazgos abiertos como corregidos al ejecutar `deliverCorrection`. Cada corrección debe identificar los hallazgos específicos que aborda. Solo esos podrán figurar como «corrección entregada». Si no existe una asociación verificable entre una corrección y un hallazgo, no lo marques como corregido por suposición."
- **L2:** Implemented an append-only attempts table instead of new finding statuses; `resolved` still belongs only to human acceptance. Rejection is a dedicated human action (`POST /api/groups/:id/reject-correction`, dashboard button) and never creates a duplicate finding.
- **L3:** G01 backfill executed against the live V2 database after migration 8. Only two associations were inserted, each backed by the correction cycle's own evidence text. Both findings now derive `correction_delivered`; G01 remains `pendiente_revision_humana` with cycle 3 `pending`.
- **L4:** Verification: `bun test` 280/280 (38 files), `tsc --noEmit` exit 0, `bun run build` exit 0; compiled binary restarted and checked in the browser (both findings show "Corrección entregada — pendiente de revisión" with one delivered attempt and the rejection control; 0 console errors).
