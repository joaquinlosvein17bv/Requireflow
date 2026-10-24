import { createDatabase } from "../../src/db/connection.ts";
import { createTask } from "../../src/domain/task.ts";

/**
 * Inserts tasks from a separate process so position assignment can be tested
 * under real concurrency (two SQLite connections, two processes).
 */
const [dbPath, projectId, prefix, count] = process.argv.slice(2);

if (!dbPath || !projectId || !prefix || !count) {
  throw new Error("Usage: insert-tasks.ts <dbPath> <projectId> <prefix> <count>");
}

const db = createDatabase(dbPath);
for (let index = 0; index < Number(count); index += 1) {
  createTask({ projectId, title: `${prefix}-${index}` }, db);
}
db.close();
