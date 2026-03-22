import {
  BOARD_PATH,
  OPENCLAW_CONTAINER_ROOT,
  OPENCLAW_HOST_ROOT,
  TASK_FIELDS,
  TASK_VIEW_ALIASES,
  TASK_VIEW_SPECS
} from "./config.mjs";
import { dateStart } from "./history.mjs";
import { getPage, queryDataSourceRows } from "./notion.mjs";
import {
  addDays,
  checkboxProperty,
  dateProperty,
  die,
  loadJson,
  monthEnd,
  normalize,
  nowDate,
  numberProperty,
  resolveRuntimePath,
  richTextProperty,
  selectProperty
} from "./util.mjs";

const HORIZON_ORDER = {
  today: 0,
  "this week": 1,
  "this month": 2,
  "this year": 3
};

export function board() {
  return loadJson(resolveBoardPath(BOARD_PATH));
}

export function mirrorRows(kind) {
  const b = board();
  const dataSourceId = b.databases[kind]?.data_source_id;
  const file = b.databases[kind]?.mirror_file;
  if (file) {
    try {
      return loadJson(resolveBoardPath(file)).rows || [];
    } catch {
      // Fall back to live Notion when the mirror is missing or unreadable.
    }
  }
  if (dataSourceId) return queryDataSourceRows(dataSourceId);
  die(`missing mirror file for ${kind}`);
}

export function plusCadence(base, cadence) {
  const value = new Date(`${base}T00:00:00Z`);
  if (cadence === "daily") value.setUTCDate(value.getUTCDate() + 1);
  else if (cadence === "weekly") value.setUTCDate(value.getUTCDate() + 7);
  else if (cadence === "monthly") value.setUTCMonth(value.getUTCMonth() + 1);
  else return null;
  return value.toISOString().slice(0, 10);
}

export function defaultHorizonForCadence(cadence) {
  if (cadence === "daily") return "today";
  if (cadence === "weekly") return "this week";
  if (cadence === "monthly") return "this month";
  return null;
}

export function inferRepeatModeFromShape({ repeatMode = null, type = null, cadence = null }) {
  if (repeatMode) return repeatMode;
  if (type === "goal_generated") return "goal_derived";
  if (cadence && cadence !== "none") return "cadence";
  if (type === "recurring") return "manual_repeat";
  return "none";
}

export function inferTypeFromShape({ type = null, repeatMode = null, cadence = null }) {
  if (type) return type;
  const resolvedRepeatMode = inferRepeatModeFromShape({ repeatMode, type, cadence });
  if (resolvedRepeatMode === "goal_derived") return "goal_generated";
  if (resolvedRepeatMode === "cadence" || resolvedRepeatMode === "manual_repeat") return "recurring";
  return "one_time";
}

export function repeatModeOf(task) {
  return inferRepeatModeFromShape({
    repeatMode: task.properties[TASK_FIELDS.repeatMode],
    type: task.properties[TASK_FIELDS.type],
    cadence: task.properties[TASK_FIELDS.cadence]
  });
}

export function summary(row) {
  return {
    id: row.id,
    title: row.title,
    stage: row.properties[TASK_FIELDS.stage],
    status: row.properties[TASK_FIELDS.status],
    horizon: row.properties[TASK_FIELDS.horizon],
    type: row.properties[TASK_FIELDS.type],
    repeat_mode: repeatModeOf(row),
    cadence: row.properties[TASK_FIELDS.cadence],
    repeat_window: row.properties[TASK_FIELDS.repeatWindow],
    repeat_target_count: row.properties[TASK_FIELDS.repeatTargetCount],
    repeat_progress: row.properties[TASK_FIELDS.repeatProgress],
    repeat_days: row.properties[TASK_FIELDS.repeatDays] || [],
    scheduling_mode: row.properties[TASK_FIELDS.schedulingMode] || null,
    due_date: dateStart(row.properties[TASK_FIELDS.dueDate]),
    scheduled_start: dateStart(row.properties[TASK_FIELDS.scheduledStart]),
    needs_calendar: row.properties[TASK_FIELDS.needsCalendar]
  };
}

export function resolveTaskView(rawView) {
  const view = TASK_VIEW_ALIASES[rawView] || rawView;
  const spec = TASK_VIEW_SPECS[view];
  if (!spec) die(`unknown view: ${rawView}`);
  return { view, spec };
}

export function selectRow(rows, query, label) {
  const q = normalize(query);
  const exact = rows.filter((row) => normalize(row.title) === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) die(`multiple ${label} exact matches for "${query}": ${exact.map((r) => r.title).join(", ")}`);

  const partial = rows.filter((row) => normalize(row.title).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) die(`no ${label} matched "${query}"`);
  die(`multiple ${label} matched "${query}": ${partial.map((r) => r.title).join(", ")}`);
}

export function resolveRelation(kind, name) {
  if (!name) return [];
  const rows = mirrorRows(kind);
  return [selectRow(rows, name, kind.slice(0, -1)).id];
}

export function resolveRelationArg(kind, args, nameFlag, idFlag) {
  if (args[idFlag]) return [args[idFlag]];
  return resolveRelation(kind, args[nameFlag]);
}

export function matchTask(args) {
  const rows = mirrorRows("tasks");
  if (args["page-id"]) {
    const row = rows.find((item) => item.id === args["page-id"]);
    if (!row) return getPage(args["page-id"]);
    return row;
  }
  const query = args.match || args.title || args._.join(" ");
  if (!query) die("missing --match");
  return selectRow(rows, query, "task");
}

export function isDoneTask(task) {
  return (
    task.archived === true ||
    task.properties[TASK_FIELDS.status] === "done" ||
    task.properties[TASK_FIELDS.stage] === "done" ||
    task.properties[TASK_FIELDS.stage] === "archived"
  );
}

export function hasCalendarFields(task) {
  return Boolean(
    dateStart(task.properties[TASK_FIELDS.scheduledStart]) ||
      dateStart(task.properties[TASK_FIELDS.scheduledEnd]) ||
      task.properties[TASK_FIELDS.calendarEventId]
  );
}

export function clearCalendarProperties() {
  return {
    [TASK_FIELDS.scheduledStart]: dateProperty(null),
    [TASK_FIELDS.scheduledEnd]: dateProperty(null),
    [TASK_FIELDS.calendarEventId]: richTextProperty("")
  };
}

export function inferHorizon(task, baseDate = nowDate()) {
  const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
  const cadence = task.properties[TASK_FIELDS.cadence];
  const repeatMode = repeatModeOf(task);

  if (dueDate) {
    if (dueDate <= baseDate) return "today";
    if (dueDate <= addDays(baseDate, 6)) return "this week";
    if (dueDate <= monthEnd(baseDate)) return "this month";
    return "this year";
  }

  if (repeatMode === "cadence" && cadence) return defaultHorizonForCadence(cadence) || "this week";
  if (repeatMode === "goal_derived") return "this year";
  return "this week";
}

export function inferNeedsCalendar(task) {
  const schedulingMode = task.properties[TASK_FIELDS.schedulingMode];
  if (schedulingMode === "hard_time" || schedulingMode === "flexible_block" || schedulingMode === "routine_window") {
    return true;
  }
  if (schedulingMode === "list_only") {
    return false;
  }
  if (task.properties[TASK_FIELDS.needsCalendar] === true) return true;
  const estimated = task.properties[TASK_FIELDS.estimatedMinutes];
  const priority = task.properties[TASK_FIELDS.priority];
  return Number(estimated || 0) >= 45 || priority === "high" || priority === "critical";
}

export function priorityWeight(value) {
  if (value === "critical") return 4;
  if (value === "high") return 3;
  if (value === "medium") return 2;
  if (value === "low") return 1;
  return 0;
}

export function isActiveTask(task) {
  return !isDoneTask(task);
}

export function defaultStageForTask(task, horizon = null) {
  if (task.properties[TASK_FIELDS.stage] === "blocked" || task.properties[TASK_FIELDS.status] === "blocked") {
    return "blocked";
  }
  const targetHorizon = horizon || task.properties[TASK_FIELDS.horizon];
  const hasSchedule =
    Boolean(dateStart(task.properties[TASK_FIELDS.scheduledStart])) ||
    Boolean(dateStart(task.properties[TASK_FIELDS.scheduledEnd]));
  if (inferNeedsCalendar(task) && !hasSchedule) return "planned";
  if (targetHorizon === "today" || targetHorizon === "this week") return "active";
  return "planned";
}

export function horizonRank(value) {
  return Object.prototype.hasOwnProperty.call(HORIZON_ORDER, value) ? HORIZON_ORDER[value] : null;
}

export function classifyHorizonMove(fromValue, toValue) {
  const from = horizonRank(fromValue);
  const to = horizonRank(toValue);
  if (from === null || to === null) return "unknown";
  if (to < from) return "promote";
  if (to > from) return "defer";
  return "same";
}

export function listRows(kind, fields) {
  return mirrorRows(kind).map((row) =>
    Object.fromEntries([
      ["id", row.id],
      ["title", row.title],
      ...fields.map((field) => [field.output, row.properties[field.property]])
    ])
  );
}

export function carryForwardProperties(carryTo, missCount) {
  return {
    [TASK_FIELDS.horizon]: selectProperty(carryTo),
    [TASK_FIELDS.stage]: selectProperty("planned"),
    [TASK_FIELDS.missCount]: numberProperty(missCount),
    ...clearCalendarProperties()
  };
}

export function triageProperties(proposal) {
  return {
    [TASK_FIELDS.horizon]: selectProperty(proposal.suggested_horizon),
    [TASK_FIELDS.stage]: selectProperty(proposal.suggested_stage),
    [TASK_FIELDS.needsCalendar]:
      proposal.suggested_needs_calendar === true ? checkboxProperty(true) : undefined
  };
}

function translateOpenClawPath(filePath, fromRoot, toRoot) {
  if (!filePath || !fromRoot || !toRoot) return null;
  if (!filePath.startsWith(fromRoot)) return null;
  return `${toRoot}${filePath.slice(fromRoot.length)}`;
}

function resolveBoardPath(filePath) {
  return resolveRuntimePath(filePath, [
    translateOpenClawPath(filePath, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
    translateOpenClawPath(filePath, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
  ]);
}
