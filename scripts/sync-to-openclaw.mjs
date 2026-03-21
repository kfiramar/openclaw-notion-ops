#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const workspaceRoot =
  process.env.OPENCLAW_WORKSPACE || "/docker/openclaw-pma3/data/.openclaw/workspace-personal";
const workspaceRootInContainer =
  process.env.OPENCLAW_WORKSPACE_IN_CONTAINER || "/data/.openclaw/workspace-personal";
const container = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
const notionApiPath =
  process.env.NOTION_API_PATH || "/data/.openclaw/skills/notion-api/scripts/notion-api.mjs";
const mirrorRoot = process.env.NOTION_MIRROR_ROOT || "/data/.openclaw/notion-mirror";
const mirrorSyncPath =
  process.env.NOTION_MIRROR_SYNC ||
  "/data/.openclaw/skills/notion-local-mirror/scripts/notion-sync.mjs";

const sourceLib = path.join(repoRoot, "src");
const targetLib = path.join(workspaceRoot, "lifestyle-ops-lib");
const sourceEntrypoint = path.join(repoRoot, "notion-board-ops.mjs");
const targetEntrypoint = path.join(workspaceRoot, "lifestyle-ops.mjs");
const targetConfig = path.join(targetLib, "config.mjs");
const targetBoardInContainer = path.posix.join(workspaceRootInContainer, "LIFESTYLE_BOARD.json");
const targetHistoryInContainer = path.posix.join(workspaceRootInContainer, "history");

const checkOnly = process.argv.includes("--check");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileIfChanged(filePath, content) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === content) {
    return false;
  }
  if (!checkOnly) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
  }
  return true;
}

function copyFileIfChanged(sourcePath, targetPath) {
  const content = fs.readFileSync(sourcePath, "utf8");
  return writeFileIfChanged(targetPath, content);
}

function liveConfigText() {
  return `export const CONTAINER = ${JSON.stringify(container)};
export const NOTION_API = ${JSON.stringify(notionApiPath)};
export const MIRROR_ROOT = ${JSON.stringify(mirrorRoot)};
export const MIRROR_SYNC = ${JSON.stringify(mirrorSyncPath)};
export const MIRROR_SYNC_MATCH = \`node \${MIRROR_SYNC} --root \${MIRROR_ROOT}\`;
export const BOARD_PATH = ${JSON.stringify(targetBoardInContainer)};
export const HISTORY_ROOT = ${JSON.stringify(targetHistoryInContainer)};
export const COMPLETIONS_ROOT = \`\${HISTORY_ROOT}/completions\`;

export const TASK_FIELDS = {
  title: "Task Name",
  stage: "Stage",
  status: "Status",
  horizon: "Horizon",
  type: "Type",
  priority: "Priority",
  needsCalendar: "Needs Calendar",
  scheduleType: "Schedule Type",
  estimatedMinutes: "Estimated Minutes",
  energy: "Energy",
  cadence: "Cadence",
  dueDate: "Due Date",
  nextDueAt: "Next Due At",
  reviewNotes: "Review Notes",
  project: "Project",
  goal: "Goal",
  blockedBy: "Blocked By",
  waitingOn: "Waiting On",
  lastCompletedAt: "Last Completed At",
  scheduledStart: "Scheduled Start",
  scheduledEnd: "Scheduled End",
  calendarEventId: "Calendar Event ID",
  missCount: "Miss Count"
};

export const TASK_VIEW_SPECS = {
  today: {
    aliases: ["daily", "today"],
    filter: (row) =>
      row.properties[TASK_FIELDS.horizon] === "today" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  week: {
    aliases: ["weekly", "week", "this_week"],
    filter: (row) =>
      row.properties[TASK_FIELDS.horizon] === "this week" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  month: {
    aliases: ["monthly", "month", "this_month"],
    filter: (row) =>
      row.properties[TASK_FIELDS.horizon] === "this month" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  year: {
    aliases: ["yearly", "year", "this_year"],
    filter: (row) =>
      row.properties[TASK_FIELDS.horizon] === "this year" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  inbox: {
    aliases: ["inbox"],
    filter: (row) => row.properties[TASK_FIELDS.stage] === "inbox"
  },
  blocked: {
    aliases: ["blocked"],
    filter: (row) =>
      row.properties[TASK_FIELDS.stage] === "blocked" &&
      row.properties[TASK_FIELDS.status] !== "done"
  },
  needs_scheduling: {
    aliases: ["needs_scheduling"],
    filter: (row) =>
      row.properties[TASK_FIELDS.needsCalendar] === true &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  execution: {
    aliases: ["execution", "execution_board"],
    filter: (row) =>
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  calendar: {
    aliases: ["calendar"],
    filter: (row) =>
      Boolean(
        row.properties[TASK_FIELDS.scheduledStart]?.start ||
          row.properties[TASK_FIELDS.scheduledEnd]?.start
      ) &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  }
};

export const TASK_VIEW_ALIASES = Object.fromEntries(
  Object.entries(TASK_VIEW_SPECS).flatMap(([name, spec]) =>
    spec.aliases.map((alias) => [alias, name])
  )
);
`;
}

function liveEntrypointText() {
  const source = fs.readFileSync(sourceEntrypoint, "utf8");
  return source
    .replaceAll('./src/', './lifestyle-ops-lib/')
    .replace("notion-board-ops", "lifestyle-ops");
}

function sync() {
  ensureDir(targetLib);

  const changed = [];
  for (const file of fs.readdirSync(sourceLib)) {
    if (!file.endsWith(".mjs") || file === "config.mjs") continue;
    const didChange = copyFileIfChanged(path.join(sourceLib, file), path.join(targetLib, file));
    if (didChange) changed.push(path.join("lifestyle-ops-lib", file));
  }

  if (writeFileIfChanged(targetConfig, liveConfigText())) {
    changed.push("lifestyle-ops-lib/config.mjs");
  }

  if (writeFileIfChanged(targetEntrypoint, liveEntrypointText())) {
    changed.push("lifestyle-ops.mjs");
  }

  if (!checkOnly) {
    fs.chmodSync(targetEntrypoint, 0o755);
  }

  if (changed.length === 0) {
    console.log(JSON.stringify({ ok: true, changed: false, files: [] }, null, 2));
    return;
  }

  console.log(JSON.stringify({ ok: true, changed: true, files: changed }, null, 2));
  if (checkOnly) {
    process.exitCode = 1;
  }
}

sync();
