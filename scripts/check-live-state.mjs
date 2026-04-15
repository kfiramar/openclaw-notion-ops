#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const OPENCLAW_CONTAINER = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
const MODEL_BACKEND_BASE_URL =
  process.env.OPENCLAW_MODEL_BASE_URL || process.env.OMNIROUTE_BASE_URL || "http://omniroute:20128/v1";
const MODEL_BACKEND_TOKEN =
  process.env.OPENCLAW_MODEL_TOKEN || process.env.OMNIROUTE_TOKEN || "omniroute-local";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
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

function modelBackendProbeUrl() {
  return new URL("models", `${MODEL_BACKEND_BASE_URL.replace(/\/$/, "")}/`).toString();
}

function runModelBackendCheck() {
  const url = modelBackendProbeUrl();
  const script = `
const url = ${JSON.stringify(url)};
const authorization = ${JSON.stringify(`Bearer ${MODEL_BACKEND_TOKEN}`)};
const container = ${JSON.stringify(OPENCLAW_CONTAINER)};

try {
  const response = await fetch(url, {
    headers: {
      Authorization: authorization
    }
  });

  if (!response.ok) {
    const detail = (await response.text()).trim();
    console.log(JSON.stringify({
      ok: false,
      action: "check-model-backend",
      container,
      url,
      status: response.status,
      detail: detail || null
    }));
    process.exit(1);
  }

  const body = await response.json();
  console.log(JSON.stringify({
    ok: true,
    action: "check-model-backend",
    container,
    url,
    status: response.status,
    model_count: Array.isArray(body?.data) ? body.data.length : null
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    action: "check-model-backend",
    container,
    url,
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
`;

  return run("docker", ["exec", OPENCLAW_CONTAINER, "node", "--input-type=module", "-e", script]);
}

const checks = [
  {
    name: "workspace",
    result: run("node", ["./scripts/sync-to-openclaw.mjs", "--check"])
  },
  {
    name: "crons",
    result: run("node", ["./scripts/sync-openclaw-crons.mjs", "--check"])
  },
  {
    name: "model-backend",
    result: runModelBackendCheck()
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
