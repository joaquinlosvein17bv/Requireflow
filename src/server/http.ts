import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/connection.ts";
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
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function resolveUiDirectory(customDir?: string): string {
  if (customDir && fs.existsSync(customDir)) {
    return customDir;
  }
  // Try src/ui or relative to current file or global home config
  const candidates = [
    path.resolve(process.cwd(), "src", "ui"),
    path.resolve(import.meta.dir, "..", "ui"),
    path.resolve(process.cwd(), "public"),
    path.join(os.homedir(), ".requireflow", "ui"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.resolve(import.meta.dir, "..", "ui");
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
      let filePath = url.pathname;
      if (filePath === "/" || filePath === "") {
        filePath = "/index.html";
      }

      const safeSuffix = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
      const fullPath = path.join(uiDir, safeSuffix);

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
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
      }

      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
      });
    },
  });

  return server;
}

export async function startHttpServer(options: HttpServerOptions = {}) {
  const server = createHttpServer(options);
  console.log(`RequireFlow HTTP Server running at http://${server.hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startHttpServer();
}
