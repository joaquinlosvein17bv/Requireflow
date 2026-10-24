import crypto from "node:crypto";

/**
 * Security model for the local HTTP API.
 *
 * Threat model: the API listens on loopback and the real boundary is the local
 * SQLite file, so the risk is a *browser* — either a malicious page using the
 * user's browser against 127.0.0.1 (CSRF and cross-origin reads) or DNS
 * rebinding pointing a public hostname at loopback.
 *
 * There are three independent controls:
 *  1. Host must be a loopback host, which defeats rebinding.
 *  2. Cross-origin requests are refused and CORS is answered only for the
 *     server's own origin, so another site can neither read nor write.
 *  3. Mutations need a per-process token that a cross-site request cannot read
 *     and cannot guess; the dashboard gets it from `/api/health`.
 *
 * This is not user authentication: any local process can read the database
 * anyway. It stops the browser-based attack surface.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface SecurityContext {
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

export function createSecurityContext(
  host: string,
  port: number,
  token: string = crypto.randomUUID()
): SecurityContext {
  const hosts = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    // An explicitly configured bind address must be reachable too.
    hosts.add(`${normalizeHost(host)}:${port}`);
  }

  return {
    token,
    allowedHosts: [...hosts],
    allowedOrigins: [...hosts].map((entry) => `http://${entry}`),
  };
}

export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function isOriginAllowed(origin: string | null, ctx: SecurityContext): boolean {
  if (origin === null) {
    // No Origin header: a non-browser client (CLI, curl, tests). Browsers always
    // send it on cross-origin requests, including form posts.
    return true;
  }
  const normalized = origin.trim().toLowerCase();
  if (normalized === "null") {
    return false;
  }
  return ctx.allowedOrigins.includes(normalized);
}

export function corsHeaders(
  origin: string | null,
  ctx: SecurityContext
): Record<string, string> {
  if (!origin || origin.trim() === "" || origin === "null") {
    return {};
  }
  const normalized = origin.trim().toLowerCase();
  if (!ctx.allowedOrigins.includes(normalized)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-RequireFlow-Token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export const TOKEN_HEADER = "x-requireflow-token";

function forbidden(message: string): Response {
  return new Response(JSON.stringify({ error: message, status: 403 }), {
    status: 403,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Returns a response when the request must be blocked, or null to continue.
 */
export function checkRequest(
  req: Request,
  _url: URL,
  ctx: SecurityContext
): Response | null {
  const host = normalizeHost(req.headers.get("host") ?? "");
  if (!ctx.allowedHosts.includes(host)) {
    return forbidden(
      `Host "${host}" is not allowed. Open RequireFlow through http://127.0.0.1 or http://localhost.`
    );
  }

  const method = req.method.toUpperCase();
  const origin = req.headers.get("origin");

  if (method === "OPTIONS") {
    return isOriginAllowed(origin, ctx)
      ? null
      : forbidden(`Origin "${origin}" is not allowed to call this API.`);
  }

  if (isMutating(method)) {
    if (!isOriginAllowed(origin, ctx)) {
      return forbidden(`Origin "${origin}" is not allowed to modify data.`);
    }
    if ((req.headers.get(TOKEN_HEADER) ?? "") !== ctx.token) {
      return forbidden(
        `Missing or invalid ${TOKEN_HEADER}. Read it from GET /api/health (same origin only) or use the dashboard.`
      );
    }
  }

  return null;
}
