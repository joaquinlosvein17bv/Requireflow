#!/usr/bin/env bun
import { runCli } from "../src/cli/index.ts";

runCli().catch((err) => {
  console.error("RequireFlow CLI Error:", err);
  process.exit(1);
});
