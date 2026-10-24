import fs from "node:fs";
import path from "node:path";

/**
 * Copies the dashboard next to the compiled executable so
 * `resolveUiDirectory` can find `<exe dir>/ui` when the binary runs from any
 * working directory.
 */
const root = path.resolve(import.meta.dir, "..");
const source = path.join(root, "src", "ui");
const destination = path.join(root, "dist", "ui");

if (!fs.existsSync(path.join(source, "index.html"))) {
  throw new Error(`Dashboard source not found at ${source}`);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });

console.log(`Bundled dashboard into ${destination}`);
