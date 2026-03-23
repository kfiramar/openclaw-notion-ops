#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const OPENCLAW = process.env.OPENCLAW_BIN || "openclaw";

function execOpenClaw(args) {
  return execFileSync(OPENCLAW, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const id = argValue("--id");
  const name = argValue("--name");
  if (!id && !name) {
    throw new Error("usage: node scripts/smoke-cron-job.mjs --id <job-id> | --name <exact job name>");
  }

  const jobs = JSON.parse(execOpenClaw(["cron", "list", "--json"])).jobs || [];
  const job = id ? jobs.find((entry) => entry.id === id) : jobs.find((entry) => entry.name === name);
  if (!job) {
    throw new Error(`cron job not found: ${id || name}`);
  }

  const run = JSON.parse(execOpenClaw(["cron", "run", job.id, "--expect-final", "--timeout", "180000"]));
  sleep(18000);
  const history = JSON.parse(execOpenClaw(["cron", "runs", "--id", job.id, "--limit", "3"]));

  console.log(JSON.stringify({
    ok: true,
    job: { id: job.id, name: job.name },
    run,
    history
  }, null, 2));
}

main();
