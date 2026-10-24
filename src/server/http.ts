import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
import { startAutoArchive } from "../domain/archive.ts";
import { handleApiRoute, CORS_HEADERS } from "./routes.ts";

export interface HttpServerOptions {
  port?: number;
  host?: string;
  db?: Database;
  uiDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function hasDashboardFiles(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the dashboard directory without ever consulting `process.cwd()`.
 *
 * Looking at the working directory first meant that running the global binary
 * inside any project owning a `src/ui` folder served that project's UI (and
 * 404s for its assets). The order below only considers the explicit override,
 * the packaged layout next to the executable, and the module-relative source
 * layout.
 */
export function resolveUiDirectory(customDir?: string): string {
  const candidates: string[] = [];

  if (customDir) {
    candidates.push(path.resolve(customDir));
  }

  const envDir = process.env.REQUIREFLOW_UI_DIR;
  if (envDir) {
    candidates.push(path.resolve(envDir));
  }

  // Packaged layout: <directory of the running executable>/ui
  candidates.push(path.resolve(path.dirname(process.execPath), "ui"));

  // Source layout: this module lives in <root>/src/server, the UI in <root>/src/ui
  candidates.push(path.resolve(import.meta.dir, "..", "ui"));

  // Legacy user-level fallback
  candidates.push(path.join(os.homedir(), ".requireflow", "ui"));

  for (const candidate of candidates) {
    if (hasDashboardFiles(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `RequireFlow dashboard files not found. Looked in: ${candidates.join(", ")}. ` +
      `Reinstall the binary or set REQUIREFLOW_UI_DIR to a directory containing index.html.`
  );
}

/**
 * Maps a request path onto the dashboard directory, refusing anything that
 * escapes it. Decoding happens before resolution so encoded traversal
 * (`%2e%2e%2f`) is contained as well.
 */
export function resolveStaticFile(uiDir: string, pathname: string): string | null {
  const uiRoot = path.resolve(uiDir);

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  const relative = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const fullPath = path.resolve(uiRoot, `.${relative}`);

  if (fullPath !== uiRoot && !fullPath.startsWith(uiRoot + path.sep)) {
    return null;
  }

  try {
    return fs.statSync(fullPath).isFile() ? fullPath : null;
  } catch {
    return null;
  }
}

export function createHttpServer(options: HttpServerOptions = {}) {
  const host = options.host || process.env.REQUIREFLOW_HOST || "127.0.0.1";
  const port = options.port ?? (Number(process.env.REQUIREFLOW_PORT) || 4242);
  const db = options.db || getDatabase();
  const uiDir = resolveUiDirectory(options.uiDir);

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // Handle REST API routes
      if (url.pathname.startsWith("/api/")) {
        const apiResponse = await handleApiRoute(req, url, db);
        if (apiResponse) {
          return apiResponse;
        }
      }

      // Handle Static UI Assets
      const fullPath = resolveStaticFile(uiDir, url.pathname);
      if (!fullPath) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
        });
      }

      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const fileContent = fs.readFileSync(fullPath);

      return new Response(fileContent, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          ...CORS_HEADERS,
        },
      });
    },
  });

  return server;
}

export async function startHttpServer(options: HttpServerOptions = {}) {
  const server = createHttpServer(options);
  const db = options.db || getDatabase();
  startAutoArchive(db);
  console.log(`RequireFlow HTTP Server running at http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startHttpServer();
}
