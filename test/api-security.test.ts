import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../src/db/connection.ts";
import { createHttpServer } from "../src/server/http.ts";
import { checkRequest, createSecurityContext } from "../src/server/security.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Local API security model (RF-04)", () => {
  let db: Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;
  let token: string;
  const tokenHeader = "x-requireflow-token";

  beforeAll(() => {
    db = createDatabase(":memory:");
    server = createHttpServer({
      port: 0,
      host: "127.0.0.1",
      db,
      token: "test-token",
      uiDir: fs.mkdtempSync(path.join(os.tmpdir(), "rf-sec-ui-")),
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    token = "test-token";
  });

  afterAll(() => {
    server.stop();
    db.close();
  });

  function projectCount(): number {
    const row = db.query("SELECT COUNT(*) as c FROM projects").get() as { c: number };
    return Number(row.c);
  }

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("rejects a mutation without the token", async () => {
    const before = projectCount();
    const res = await post({ name: "no token" });

    expect(res.status).toBe(403);
    expect(projectCount()).toBe(before);
  });

  it("rejects a mutation with a wrong token", async () => {
    const res = await post({ name: "wrong token" }, { [tokenHeader]: "not-the-token" });
    expect(res.status).toBe(403);
  });

  it("accepts a mutation with the token", async () => {
    const res = await post({ name: "authorized" }, { [tokenHeader]: token });
    expect(res.status).toBe(201);
  });

  it("still allows reads without a token", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
  });

  it("exposes the token through the origin-restricted health endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBe(token);
  });

  it("refuses a mutation coming from another origin even with a valid token", async () => {
    const res = await post(
      { name: "cross site" },
      { [tokenHeader]: token, Origin: "https://evil.example" }
    );
    expect(res.status).toBe(403);
  });

  it("refuses an opaque origin", async () => {
    const res = await post({ name: "null origin" }, { [tokenHeader]: token, Origin: "null" });
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin mutation and never answers with a wildcard", async () => {
    const res = await post(
      { name: "same origin" },
      { [tokenHeader]: token, Origin: baseUrl }
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(baseUrl);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("does not grant CORS access to other origins", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a Host header that is not loopback (DNS rebinding)", async () => {
    const ctx = createSecurityContext("127.0.0.1", 4242, "token-123");
    const rebound = new Request("http://attacker.example:4242/api/projects", {
      method: "GET",
      headers: { host: "attacker.example:4242" },
    });

    const blocked = checkRequest(rebound, new URL(rebound.url), ctx);
    expect(blocked?.status).toBe(403);
  });

  it("allows loopback hosts", () => {
    const ctx = createSecurityContext("127.0.0.1", 4242, "token-123");

    for (const host of ["127.0.0.1:4242", "localhost:4242", "[::1]:4242"]) {
      const req = new Request(`http://${host}/api/projects`, { headers: { host } });
      expect(checkRequest(req, new URL(req.url), ctx)).toBeNull();
    }
  });

  it("handles preflight only for allowed origins", async () => {
    const allowed = await fetch(`${baseUrl}/api/projects`, {
      method: "OPTIONS",
      headers: { Origin: baseUrl, "Access-Control-Request-Method": "POST" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(baseUrl);

    const denied = await fetch(`${baseUrl}/api/projects`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(denied.status).toBe(403);
  });
});
