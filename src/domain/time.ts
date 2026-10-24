/**
 * Canonical time representation for RequireFlow.
 *
 * Every timestamp written by the application is an ISO 8601 string in UTC with
 * milliseconds and a `Z` suffix. SQLite's `CURRENT_TIMESTAMP` produces
 * `YYYY-MM-DD HH:MM:SS` in UTC *without* a zone, and `new Date()` parses that
 * shape as local time — the mix silently shifted lead times by the machine
 * offset (RF-11). One shape everywhere removes the ambiguity.
 */

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

export function isCanonicalIso(value: string): boolean {
  return ISO_PATTERN.test(value);
}

/** ISO timestamp `days` before `reference` (negative values move forward). */
export function isoDaysAgo(days: number, reference: Date = new Date()): string {
  return new Date(reference.getTime() - days * 86_400_000).toISOString();
}

/** ISO timestamp at the start of the current UTC day. */
export function startOfUtcDay(reference: Date = new Date()): string {
  return new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate())
  ).toISOString();
}

/** Whole UTC days between two instants, used to build dense series. */
export function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Seconds between two timestamps, never negative for a well-formed pair. */
export function secondsBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`Invalid timestamps: ${startIso} -> ${endIso}`);
  }
  return Math.round((end - start) / 1000);
}
