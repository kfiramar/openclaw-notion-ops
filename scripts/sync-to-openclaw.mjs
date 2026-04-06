#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const mirrorSyncHostPath = process.env.NOTION_MIRROR_SYNC_HOST || null;

const sourceLib = path.join(repoRoot, "src");
const sourceMirrorSync = path.join(repoRoot, "scripts", "notion-local-mirror-sync.mjs");
const targetLib = path.join(workspaceRoot, "lifestyle-ops-lib");
const sourceEntrypoint = path.join(repoRoot, "notion-board-ops.mjs");
const targetEntrypoint = path.join(workspaceRoot, "lifestyle-ops.mjs");
const targetConfig = path.join(targetLib, "config.mjs");
const sourceBoard = process.env.BOARD_PATH || path.join(repoRoot, "board.json");
const targetBoard = path.join(workspaceRoot, "LIFESTYLE_BOARD.json");
const targetBoardInContainer = path.posix.join(workspaceRootInContainer, "LIFESTYLE_BOARD.json");
const targetHistoryInContainer = path.posix.join(workspaceRootInContainer, "history");
const openclawHostRoot = path.dirname(workspaceRoot);
const openclawContainerRoot = path.posix.dirname(workspaceRootInContainer);

const checkOnly = process.argv.includes("--check");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileIfChanged(filePath, content, { check = checkOnly } = {}) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === content) {
    return false;
  }
  if (!check) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content);
  }
  return true;
}

export function copyFileIfChanged(sourcePath, targetPath, options = {}) {
  const content = fs.readFileSync(sourcePath, "utf8");
  return writeFileIfChanged(targetPath, content, options);
}

function translateContainerPathToHost(filePath) {
  if (!filePath) return null;
  if (filePath.startsWith(openclawContainerRoot)) {
    return path.join(openclawHostRoot, filePath.slice(openclawContainerRoot.length));
  }
  return null;
}

export function liveConfigText() {
  return `export const CONTAINER = ${JSON.stringify(container)};
export const PRIMARY_CALENDAR_ID = ${JSON.stringify(process.env.PRIMARY_CALENDAR_ID || "suukpehoy@gmail.com")};
export const NOTION_API = ${JSON.stringify(notionApiPath)};
export const MIRROR_ROOT = ${JSON.stringify(mirrorRoot)};
export const MIRROR_SYNC = ${JSON.stringify(mirrorSyncPath)};
export const MIRROR_SYNC_MATCH = \`node \${MIRROR_SYNC} --root \${MIRROR_ROOT}\`;
export const OPENCLAW_HOST_ROOT = ${JSON.stringify(openclawHostRoot)};
export const OPENCLAW_CONTAINER_ROOT = ${JSON.stringify(openclawContainerRoot)};
export const BOARD_PATH = ${JSON.stringify(targetBoardInContainer)};
export const HISTORY_ROOT = ${JSON.stringify(targetHistoryInContainer)};
export const COMPLETIONS_ROOT = \`\${HISTORY_ROOT}/completions\`;
export const POLL_STATE_ROOT = \`\${HISTORY_ROOT}/polls\`;
export const TELEGRAM_POLL_HISTORY_ROOT = \`\${HISTORY_ROOT}/telegram-polls\`;
export const TELEGRAM_POLL_ACCOUNT = ${JSON.stringify(process.env.OPENCLAW_TELEGRAM_ACCOUNT || "bot4")};
export const TELEGRAM_POLL_TARGET = ${JSON.stringify(process.env.OPENCLAW_TELEGRAM_TO || "492482728")};
export const DISABLE_BACKGROUND_SYNC = /^(1|true|yes)$/i.test(
  String(process.env.NOTION_OPS_DISABLE_BACKGROUND_SYNC || "")
);

import { nowDate } from "./util.mjs";

export const TASK_FIELDS = {
  title: "Task Name",
  stage: "Stage",
  status: "Status",
  horizon: "Horizon",
  type: "Type",
  repeatMode: "Repeat Mode",
  priority: "Priority",
  needsCalendar: "Needs Calendar",
  schedulingMode: "Scheduling Mode",
  scheduleType: "Schedule Type",
  estimatedMinutes: "Estimated Minutes",
  energy: "Energy",
  cadence: "Cadence",
  repeatWindow: "Repeat Window",
  repeatTargetCount: "Repeat Target Count",
  repeatProgress: "Repeat Progress",
  repeatDays: "Repeat Days",
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
      row.archived !== true &&
      row.properties[TASK_FIELDS.horizon] === "today" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  week: {
    aliases: ["weekly", "week", "this_week"],
    filter: (row) =>
      row.archived !== true &&
      row.properties[TASK_FIELDS.horizon] === "this week" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  month: {
    aliases: ["monthly", "month", "this_month"],
    filter: (row) =>
      row.archived !== true &&
      row.properties[TASK_FIELDS.horizon] === "this month" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  year: {
    aliases: ["yearly", "year", "this_year"],
    filter: (row) =>
      row.archived !== true &&
      row.properties[TASK_FIELDS.horizon] === "this year" &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  inbox: {
    aliases: ["inbox"],
    filter: (row) => row.archived !== true && row.properties[TASK_FIELDS.stage] === "inbox"
  },
  blocked: {
    aliases: ["blocked"],
    filter: (row) =>
      row.archived !== true &&
      row.properties[TASK_FIELDS.stage] === "blocked" &&
      row.properties[TASK_FIELDS.status] !== "done"
  },
  overdue: {
    aliases: ["overdue"],
    filter: (row) => {
      const dueDate = row.properties[TASK_FIELDS.dueDate]?.start || row.properties[TASK_FIELDS.dueDate];
      return (
        row.archived !== true &&
        Boolean(dueDate) &&
        dueDate < nowDate() &&
        row.properties[TASK_FIELDS.status] !== "done" &&
        row.properties[TASK_FIELDS.stage] !== "archived"
      );
    }
  },
  needs_scheduling: {
    aliases: ["needs_scheduling"],
    filter: (row) =>
      row.archived !== true &&
      row.properties[TASK_FIELDS.needsCalendar] === true &&
      !row.properties[TASK_FIELDS.calendarEventId] &&
      !row.properties[TASK_FIELDS.scheduledStart]?.start &&
      !row.properties[TASK_FIELDS.scheduledEnd]?.start &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  execution: {
    aliases: ["execution", "execution_board"],
    filter: (row) =>
      row.archived !== true &&
      row.properties[TASK_FIELDS.status] !== "done" &&
      row.properties[TASK_FIELDS.stage] !== "archived"
  },
  calendar: {
    aliases: ["calendar"],
    filter: (row) =>
      row.archived !== true &&
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

export function liveEntrypointText() {
  const source = fs.readFileSync(sourceEntrypoint, "utf8");
  return source
    .replaceAll('./src/', './lifestyle-ops-lib/')
    .replace("notion-board-ops", "lifestyle-ops");
}

export function syncOpenClaw({ check = checkOnly } = {}) {
  ensureDir(targetLib);

  const changed = [];
  for (const file of fs.readdirSync(sourceLib)) {
    if (!file.endsWith(".mjs") || file === "config.mjs") continue;
    const didChange = copyFileIfChanged(path.join(sourceLib, file), path.join(targetLib, file), { check });
    if (didChange) changed.push(path.join("lifestyle-ops-lib", file));
  }

  if (writeFileIfChanged(targetConfig, liveConfigText(), { check })) {
    changed.push("lifestyle-ops-lib/config.mjs");
  }

  if (writeFileIfChanged(targetEntrypoint, liveEntrypointText(), { check })) {
    changed.push("lifestyle-ops.mjs");
  }

  if (fs.existsSync(sourceBoard)) {
    if (copyFileIfChanged(sourceBoard, targetBoard, { check })) {
      changed.push("LIFESTYLE_BOARD.json");
    }
  }

  const targetMirrorSync =
    mirrorSyncHostPath ||
    translateContainerPathToHost(mirrorSyncPath) ||
    path.join(openclawHostRoot, "skills", "notion-local-mirror", "scripts", "notion-sync.mjs");
  if (copyFileIfChanged(sourceMirrorSync, targetMirrorSync, { check })) {
    changed.push(path.relative(openclawHostRoot, targetMirrorSync));
  }

  if (!check) {
    fs.chmodSync(targetEntrypoint, 0o755);
    if (fs.existsSync(targetMirrorSync)) {
      fs.chmodSync(targetMirrorSync, 0o755);
    }
  }

  if (changed.length === 0) {
    return { ok: true, changed: false, files: [] };
  }

  return { ok: true, changed: true, files: changed };
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  const result = syncOpenClaw({ check: checkOnly });
  console.log(JSON.stringify(result, null, 2));
  if (checkOnly && result.changed) {
    process.exitCode = 1;
  }
}
