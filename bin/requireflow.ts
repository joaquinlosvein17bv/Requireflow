#!/usr/bin/env bun
import { runCli } from "../src/cli/index.ts";
import { LegacyDatabaseError } from "../src/db/connection.ts";

runCli().catch((err) => {
  if (err instanceof LegacyDatabaseError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  console.error("RequireFlow CLI Error:", err);
  process.exit(1);
});
