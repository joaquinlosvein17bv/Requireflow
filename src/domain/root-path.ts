import path from "node:path";

/**
 * Canonical form of a project root used as its identity.
 *
 * Two checkouts of the same directory must map to the same key, while two
 * different directories must never collide — that was possible when the
 * project name (a bare basename) was the identity.
 *
 * The key is absolute, uses forward slashes, has no trailing separator, and is
 * lower-cased on case-insensitive platforms. The stored `root_path` keeps the
 * user-facing spelling; only `root_key` is normalized.
 */
export function normalizeRootPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";

  // Windows long-path prefix: \\?\C:\... -> C:\...
  const withoutPrefix = trimmed.replace(/^\\\\\?\\/, "");

  let resolved = path.resolve(withoutPrefix);
  resolved = resolved.replace(/\\/g, "/");
  resolved = resolved.replace(/\/{2,}/g, "/");

  if (process.platform === "win32") {
    resolved = resolved.toLowerCase();
  }

  const isFilesystemRoot = resolved === "/" || /^[a-zA-Z]:\/$/.test(resolved);
  if (!isFilesystemRoot && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }

  return resolved;
}

/** True when `candidate` is the root itself or lives inside it. */
export function isInsideRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}
