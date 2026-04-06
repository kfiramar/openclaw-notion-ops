import path from "node:path";

import { nowDate } from "./util.mjs";

const CWD = process.cwd();

export const CONTAINER = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
export const PRIMARY_CALENDAR_ID = process.env.PRIMARY_CALENDAR_ID || "suukpehoy@gmail.com";
export const NOTION_API = process.env.NOTION_API_PATH || "/data/.openclaw/skills/notion-api/scripts/notion-api.mjs";
export const MIRROR_ROOT = process.env.NOTION_MIRROR_ROOT || "/data/.openclaw/notion-mirror";
export const MIRROR_SYNC = process.env.NOTION_MIRROR_SYNC || "/data/.openclaw/skills/notion-local-mirror/scripts/notion-sync.mjs";
export const MIRROR_SYNC_MATCH = `node ${MIRROR_SYNC} --root ${MIRROR_ROOT}`;
export const OPENCLAW_HOST_ROOT =
  process.env.OPENCLAW_HOST_ROOT || "/docker/openclaw-pma3/data/.openclaw";
export const OPENCLAW_CONTAINER_ROOT =
  process.env.OPENCLAW_CONTAINER_ROOT || "/data/.openclaw";
export const BOARD_PATH = process.env.BOARD_PATH || path.join(CWD, "board.json");
export const HISTORY_ROOT = process.env.HISTORY_ROOT || path.join(CWD, "history");
export const COMPLETIONS_ROOT = path.join(HISTORY_ROOT, "completions");
export const POLL_STATE_ROOT = path.join(HISTORY_ROOT, "polls");
export const TELEGRAM_POLL_HISTORY_ROOT = path.join(HISTORY_ROOT, "telegram-polls");
export const TELEGRAM_POLL_ACCOUNT = process.env.OPENCLAW_TELEGRAM_ACCOUNT || "bot4";
export const TELEGRAM_POLL_TARGET = process.env.OPENCLAW_TELEGRAM_TO || "492482728";
export const DISABLE_BACKGROUND_SYNC = /^(1|true|yes)$/i.test(
  String(process.env.NOTION_OPS_DISABLE_BACKGROUND_SYNC || "")
);

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
