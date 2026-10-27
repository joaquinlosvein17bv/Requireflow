import crypto from "node:crypto";

/** Raised when a planning operation would break a product invariant. */
export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

/**
 * Placeholders are not requirements.
 *
 * The skill must ask the user before persisting, and the domain refuses the
 * markers that used to stand in for an answer.
 */
const PLACEHOLDER_PATTERN =
  /(\[\s*no\s+especificado[^\]]*\]|\bno\s+especificado\b|\bTODO\b|\bTBD\b|\bpor\s+definir\b|\bpendiente\s+de\s+definir\b|\?\?\?)/i;

export function hasPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

export function assertConfirmedText(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanValidationError(`"${field}" is required and must be a non-empty string`);
  }
  if (value.length > max) {
    throw new PlanValidationError(`"${field}" must be at most ${max} characters`);
  }
  if (hasPlaceholder(value)) {
    throw new PlanValidationError(
      `"${field}" still contains an unspecified marker. Ask the user and persist only a confirmed value.`
    );
  }
  return value.trim();
}

/** Groups may be reshaped while they are being planned or approved. */
export const SCOPE_EDITABLE_STATUSES = [
  "planificado",
  "en_refinamiento",
  "listo_para_aprobacion",
  "aprobado",
] as const;

export interface ScopeGuardTarget {
  code: string;
  status: string;
}

export function assertScopeEditable(increment: ScopeGuardTarget): void {
  if (!(SCOPE_EDITABLE_STATUSES as readonly string[]).includes(increment.status)) {
    throw new PlanValidationError(
      `Group ${increment.code} is '${increment.status}': its scope cannot be edited now. ` +
        `Finish the current stage, or register the change as a new scope revision when the group returns to planning.`
    );
  }
}

export interface ScopeHashInput {
  stories: Array<{ id: string; version: number }>;
  criteria: Array<{ id: string; version: number }>;
  decisions: Array<{ id: string; version: number }>;
}

/**
 * Fingerprint of everything the human approved.
 *
 * Any edit to a story, criterion or decision changes the fingerprint, so an
 * approved group cannot be implemented silently after its scope moved.
 */
export function computeScopeHash(input: ScopeHashInput): string {
  const canonical = {
    stories: [...input.stories]
      .map((story) => `${story.id}:${story.version}`)
      .sort(),
    criteria: [...input.criteria]
      .map((criterion) => `${criterion.id}:${criterion.version}`)
      .sort(),
    decisions: [...input.decisions]
      .map((decision) => `${decision.id}:${decision.version}`)
      .sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
