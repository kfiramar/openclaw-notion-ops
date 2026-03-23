#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const WRAPPER = process.env.LIFESTYLE_WRAPPER || "/docker/openclaw-pma3/data/.openclaw/workspace-personal/lifestyle-ops.mjs";
const DATE = process.env.EOD_POLL_DATE || "today";

const output = execFileSync("node", [
  WRAPPER,
  "send-eod-poll",
  "--date",
  DATE,
  "--dry-run"
], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

console.log(output.trim());
