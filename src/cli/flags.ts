/**
 * CLI flag parsing helpers.
 *
 * Flags used to be interpreted as `value !== false`, which made every boolean
 * flag true by default — `requireflow archive` always forced the flush and
 * `--force false` could not turn it off (RF-07, RF-19).
 */

const TRUE_VALUES = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "n", "off"]);

export function flagToBoolean(
  value: string | boolean | undefined,
  fallback: boolean = false
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  throw new Error(
    `Invalid boolean value "${value}". Use the flag alone or --flag=true / --flag=false.`
  );
}

export interface NumberFlagOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  label?: string;
}

export function flagToNumber(
  value: string | boolean | undefined,
  options: NumberFlagOptions = {}
): number | undefined {
  if (value === undefined || typeof value === "boolean") return undefined;

  const label = options.label ?? "value";
  const trimmed = value.trim();
  const parsed = options.integer === false ? Number(trimmed) : Number.parseInt(trimmed, 10);

  if (trimmed === "" || Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: "${value}". Expected a number.`);
  }
  if (options.integer !== false && `${parsed}` !== trimmed && !/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: "${value}". Expected an integer.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Invalid ${label}: ${parsed}. Minimum is ${options.min}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Invalid ${label}: ${parsed}. Maximum is ${options.max}.`);
  }

  return parsed;
}
