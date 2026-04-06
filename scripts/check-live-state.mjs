#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function parseJson(text) {
  const clean = String(text || "").trim();
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

const checks = [
  {
    name: "workspace",
    result: run("node", ["./scripts/sync-to-openclaw.mjs", "--check"])
  },
  {
    name: "crons",
    result: run("node", ["./scripts/sync-openclaw-crons.mjs", "--check"])
  }
];

const summary = checks.map(({ name, result }) => ({
  name,
  status: result.status,
  stdout: parseJson(result.stdout),
  stderr: result.stderr.trim() || null
}));

const ok = summary.every((entry) => entry.status === 0);
console.log(JSON.stringify({ ok, action: "check-live-state", checks: summary }, null, 2));
process.exit(ok ? 0 : 1);
