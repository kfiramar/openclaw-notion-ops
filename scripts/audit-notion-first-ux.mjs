#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const workspaceRoot =
  process.env.OPENCLAW_WORKSPACE || "/docker/openclaw-pma3/data/.openclaw/workspace-personal";
const boardPath = process.env.BOARD_PATH || `${workspaceRoot}/LIFESTYLE_BOARD.json`;
const container = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
const notionApiPath =
  process.env.NOTION_API_PATH || "/data/.openclaw/skills/notion-api/scripts/notion-api.mjs";

const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));

function notionJson(args) {
  const output = execFileSync(
    "docker",
    ["exec", container, "node", notionApiPath, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(output);
}

function runNodeJson(scriptPath) {
  const output = execFileSync("node", [scriptPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}

const dataSource = notionJson(["get-data-source", "--data-source-id", board.databases.tasks.data_source_id]);
const properties = dataSource.properties || {};

const requiredProperties = [
  "Status",
  "Stage",
  "Horizon",
  "Needs Calendar",
  "Scheduled Start",
  "Scheduled End",
  "Schedule Type",
  "Estimated Minutes",
  "Review Notes"
];

const propertyChecks = requiredProperties.map((name) => ({
  label: name,
  ok: Boolean(properties[name])
}));

const dashboardChecks = runNodeJson("/root/openclaw-notion-ops/scripts/check-dashboards.mjs");

const result = {
  ok: dashboardChecks.ok && propertyChecks.every((item) => item.ok),
  action: "audit-notion-first-ux",
  data_source_id: board.databases.tasks.data_source_id,
  dashboards_ok: dashboardChecks.ok,
  dashboard_checks: dashboardChecks,
  schema_checks: propertyChecks,
  manual_remaining: [
    "Create or tune the actual Notion database views: Today Execution, Today Calendar, Today Needs Time, and weekly equivalents.",
    "Add formula properties like Time Label and Schedule Day manually in Notion if desired.",
    "Replace generic calendar links with dedicated today-only calendar views after those views exist."
  ],
  api_limitations: [
    "Notion public API does not support creating or editing database views.",
    "Formula-property setup still requires manual Notion UI work for this board."
  ]
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
