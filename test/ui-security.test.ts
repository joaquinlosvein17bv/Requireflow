import { describe, it, expect } from "bun:test";
import { escapeHtml, safeColor } from "../src/ui/safe-dom.js";
import fs from "node:fs";
import path from "node:path";

const UI_DIR = path.resolve(import.meta.dir, "..", "src", "ui");

describe("Dashboard stored XSS defenses (RF-03)", () => {
  it("escapes markup in text that must be placed inside HTML", () => {
    const payload = `<img src=x onerror="alert(1)">`;
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#039;&amp;");
    expect(escapeHtml(null)).toBe("");
  });

  it("accepts only CSS colour literals and rejects attribute breakouts", () => {
    expect(safeColor("#6366f1")).toBe("#6366f1");
    expect(safeColor("#fff")).toBe("#fff");
    expect(safeColor("#6366f1aa")).toBe("#6366f1aa");
    expect(safeColor("red")).toBe("red");

    const fallback = "#6366f1";
    expect(safeColor('red;" onmouseover="alert(1)')).toBe(fallback);
    expect(safeColor("url(javascript:alert(1))")).toBe(fallback);
    expect(safeColor("expression(alert(1))")).toBe(fallback);
    expect(safeColor(undefined)).toBe(fallback);
  });

  it("never interpolates data into innerHTML", () => {
    const source = fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8");
    const templateAssignments = source
      .split("\n")
      .map((line, index) => ({ line, index: index + 1 }))
      .filter((entry) => entry.line.includes("innerHTML") && entry.line.includes("${"));

    expect(templateAssignments).toEqual([]);
  });

  it("loads the client as a module so the safe DOM helpers are used", () => {
    const html = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
    expect(html).toContain('<script type="module" src="/app.js"></script>');
  });
});
