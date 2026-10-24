import type { Task } from "../src/domain/task.ts";

/** Reads an array position, failing loudly instead of returning undefined. */
export function requireAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index}, found ${items.length} item(s)`);
  }
  return item;
}

/** Narrow HTTP JSON responses at the transport boundary. */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Narrows a JSON.parse result at the transport boundary. */
export function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export interface BoardResponse {
  todo: Task[];
  in_progress: Task[];
  done: Task[];
}
