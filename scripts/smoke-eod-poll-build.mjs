#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const WRAPPER = process.env.LIFESTYLE_WRAPPER || "/docker/openclaw-pma3/data/.openclaw/workspace-personal/lifestyle-ops.mjs";
const DATE = process.env.EOD_POLL_DATE || "today";

function run(args) {
  return execFileSync("node", [WRAPPER, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

const candidates = JSON.parse(run(["list-eod-poll-candidates", "--date", DATE]));
const poll = JSON.parse(run(["build-eod-poll", "--date", DATE]));

console.log(JSON.stringify({
  ok: true,
  action: "smoke-eod-poll-build",
  candidates,
  poll
}, null, 2));
