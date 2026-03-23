#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const OPENCLAW = process.env.OPENCLAW_BIN || "openclaw";

export function execOpenClaw(args) {
  return execFileSync(OPENCLAW, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function execOpenClawResult(args) {
  const result = spawnSync(OPENCLAW, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function parseJsonFromMixedOutput(text) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("empty OpenClaw output");
  try {
    return JSON.parse(clean);
  } catch {
    const lines = clean.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = lines.slice(index).join("\n").trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // keep scanning
      }
    }
  }
  throw new Error(`could not parse OpenClaw JSON output:\n${clean}`);
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function findCronJob({ id = null, name = null } = {}) {
  const jobs = parseJsonFromMixedOutput(execOpenClaw(["cron", "list", "--json"])).jobs || [];
  return id ? jobs.find((entry) => entry.id === id) : jobs.find((entry) => entry.name === name);
}

export function runCronSmoke({ id = null, name = null, historyLimit = 3, waitMs = 18000 } = {}) {
  if (!id && !name) {
    throw new Error("usage: node scripts/smoke-cron-job.mjs --id <job-id> | --name <exact job name>");
  }

  const job = findCronJob({ id, name });
  if (!job) {
    throw new Error(`cron job not found: ${id || name}`);
  }

  const runResult = execOpenClawResult(["cron", "run", job.id, "--expect-final", "--timeout", "180000"]);
  const run = parseJsonFromMixedOutput(runResult.stdout);
  if (runResult.status !== 0 && !(run?.ok === true && run?.reason === "already-running")) {
    throw new Error(
      `openclaw cron run failed for ${job.name}\nstdout:\n${runResult.stdout}\nstderr:\n${runResult.stderr}`
    );
  }
  sleep(waitMs);
  const historyResult = execOpenClawResult(["cron", "runs", "--id", job.id, "--limit", String(historyLimit)]);
  const history = parseJsonFromMixedOutput(historyResult.stdout);
  if (historyResult.status !== 0) {
    throw new Error(
      `openclaw cron runs failed for ${job.name}\nstdout:\n${historyResult.stdout}\nstderr:\n${historyResult.stderr}`
    );
  }

  return {
    ok: true,
    job: { id: job.id, name: job.name },
    run,
    history
  };
}

function main() {
  const id = argValue("--id");
  const name = argValue("--name");
  console.log(JSON.stringify(runCronSmoke({ id, name }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
