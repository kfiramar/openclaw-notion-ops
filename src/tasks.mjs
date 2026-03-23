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
  selectProperty,
  sleep
} from "./util.mjs";

const HORIZON_ORDER = {
  today: 0,
  "this week": 1,
  "this month": 2,
  "this year": 3
};

const MULTI_EVENT_PREFIX = "multi:";

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
    needs_calendar: row.properties[TASK_FIELDS.needsCalendar],
    auto_complete_when_scheduled: isAutoCompleteWhenScheduledTask(row)
  };
}

export function reviewNotesOf(task) {
  return String(task?.properties?.[TASK_FIELDS.reviewNotes] || "");
}

export function isAutoCompleteWhenScheduledTask(task) {
  const notes = normalize(reviewNotesOf(task));
  return (
    notes.includes("@auto-done") ||
    notes.includes("@auto-done-scheduled") ||
    notes.includes("@auto-complete-scheduled") ||
    notes.includes("auto done when scheduled")
  );
}

export function scheduledTouchesDate(task, date) {
  const scheduledStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  const scheduledEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]) || scheduledStart;
  if (!scheduledStart || !scheduledEnd || !date) return false;
  const startDay = scheduledStart.slice(0, 10);
  const endDay = scheduledEnd.slice(0, 10);
  return startDay <= date && endDay >= date;
}

export function scheduleStateOf(task) {
  const scheduledStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  const scheduledEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
  const calendarRefs = calendarRefsOf(task);
  const calendarEventId = calendarRefs[0]?.event_id || "";

  if (calendarRefs.length > 1) return "scheduled_multi";
  if (scheduledStart && scheduledEnd && calendarEventId) return "scheduled_linked";
  if (scheduledStart && scheduledEnd) return "scheduled_unlinked";
  if (calendarEventId) return "linked_without_schedule";
  return "unscheduled";
}

function normalizeCalendarRef(ref) {
  if (!ref || !ref.event_id) return null;
  return {
    event_id: String(ref.event_id),
    start: ref.start || null,
    end: ref.end || null
  };
}

export function calendarRefsOf(task) {
  const raw = task.properties[TASK_FIELDS.calendarEventId] || "";
  if (!raw) return [];
  if (typeof raw === "string" && raw.startsWith(MULTI_EVENT_PREFIX)) {
    try {
      const parsed = JSON.parse(raw.slice(MULTI_EVENT_PREFIX.length));
      const refs = Array.isArray(parsed) ? parsed : parsed?.refs;
      if (Array.isArray(refs)) {
        return refs.map(normalizeCalendarRef).filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  return [
    {
      event_id: String(raw),
      start: dateStart(task.properties[TASK_FIELDS.scheduledStart]),
      end: dateStart(task.properties[TASK_FIELDS.scheduledEnd])
    }
  ].filter((ref) => ref.event_id);
}

export function calendarEventIdsOf(task) {
  return calendarRefsOf(task).map((ref) => ref.event_id).filter(Boolean);
}

export function primaryCalendarRefOf(task) {
  return calendarRefsOf(task)[0] || null;
}

export function encodeCalendarRefs(refs) {
  const cleaned = (refs || []).map(normalizeCalendarRef).filter(Boolean);
  if (cleaned.length === 0) return richTextProperty("");
  if (cleaned.length === 1) return richTextProperty(cleaned[0].event_id);
  return richTextProperty(`${MULTI_EVENT_PREFIX}${JSON.stringify(cleaned)}`);
}

export function taskLookupSummary(task) {
  const calendarRefs = calendarRefsOf(task);
  return {
    page_id: task.id,
    title: task.title,
    archived: Boolean(task.archived),
    stage: task.properties[TASK_FIELDS.stage] || null,
    status: task.properties[TASK_FIELDS.status] || null,
    horizon: task.properties[TASK_FIELDS.horizon] || null,
    type: task.properties[TASK_FIELDS.type] || null,
    repeat_mode: repeatModeOf(task),
    schedule_state: scheduleStateOf(task),
    auto_complete_when_scheduled: isAutoCompleteWhenScheduledTask(task),
    needs_calendar: task.properties[TASK_FIELDS.needsCalendar] === true,
    calendar_event_id: calendarRefs[0]?.event_id || null,
    calendar_event_ids: calendarRefs.map((ref) => ref.event_id),
    scheduled_start: dateStart(task.properties[TASK_FIELDS.scheduledStart]),
    scheduled_end: dateStart(task.properties[TASK_FIELDS.scheduledEnd]),
    created_time: task.created_time || null,
    last_edited_time: task.last_edited_time || null
  };
}

export function resolveTaskView(rawView) {
  const view = TASK_VIEW_ALIASES[rawView] || rawView;
  const spec = TASK_VIEW_SPECS[view];
  if (!spec) die(`unknown view: ${rawView}`);
  return { view, spec };
}

function taskQuerySpec(args) {
  const exactTitle = args["title-exact"];
  const query = exactTitle || args.match || args.title || args._.join(" ");
  return {
    query,
    exact: Boolean(exactTitle),
    latest: args.latest === true,
    first: args.first === true,
    includeArchived: args["include-archived"] === true
  };
}

function sortRowsByRecency(rows, direction = "desc") {
  const factor = direction === "asc" ? 1 : -1;
  const originalIndex = new Map(rows.map((row, index) => [row.id, index]));
  return [...rows].sort((a, b) => {
    const aEdited = Date.parse(a.last_edited_time || a.created_time || "");
    const bEdited = Date.parse(b.last_edited_time || b.created_time || "");
    if (!Number.isNaN(aEdited) && !Number.isNaN(bEdited) && aEdited !== bEdited) {
      return (aEdited - bEdited) * factor;
    }
    const aCreated = Date.parse(a.created_time || "");
    const bCreated = Date.parse(b.created_time || "");
    if (!Number.isNaN(aCreated) && !Number.isNaN(bCreated) && aCreated !== bCreated) {
      return (aCreated - bCreated) * factor;
    }
    const aIndex = originalIndex.get(a.id) ?? 0;
    const bIndex = originalIndex.get(b.id) ?? 0;
    if (aIndex !== bIndex) {
      return (aIndex - bIndex) * factor;
    }
    if (a.id !== b.id) {
      return a.id.localeCompare(b.id) * factor;
    }
    return (a.title || "").localeCompare(b.title || "") * factor;
  });
}

export function hasPatternSyntax(query) {
  return /[*?]/.test(String(query || ""));
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function patternRegex(query) {
  const source = [...normalize(query)]
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return escapeRegex(char);
    })
    .join("");
  return new RegExp(`^${source}$`);
}

export function matchingRows(rows, query, { exact = false } = {}) {
  const q = normalize(query);
  if (!q) return [];

  const exactMatches = rows.filter((row) => normalize(row.title) === q);
  if (exactMatches.length > 0 || exact === true) return exactMatches;

  if (!exact && hasPatternSyntax(query)) {
    const regex = patternRegex(query);
    const patternMatches = rows.filter((row) => regex.test(normalize(row.title)));
    if (patternMatches.length > 0) return patternMatches;
  }

  if (exact) return [];
  return rows.filter((row) => normalize(row.title).includes(q));
}

export function selectRow(rows, query, label, options = {}) {
  const matches = matchingRows(rows, query, options);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) die(`no ${label} matched "${query}"`);
  die(`multiple ${label} matched "${query}": ${matches.map((r) => r.title).join(", ")}`);
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

function liveRows(kind) {
  const dataSourceId = board().databases[kind]?.data_source_id;
  if (!dataSourceId) return [];
  return queryDataSourceRows(dataSourceId);
}

function liveMatchesWithRetry(kind, query, options = {}) {
  const shouldRetry = options.exact === true || hasPatternSyntax(query);
  const attempts = shouldRetry ? 3 : 1;
  const merged = new Map();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const freshRows = liveRows(kind);
    const freshMatches = matchingRows(freshRows, query, options);
    for (const row of freshMatches) merged.set(row.id, row);
    if (!shouldRetry || freshMatches.length > 1 || attempt === attempts - 1) {
      break;
    }
    sleep(250);
  }

  return [...merged.values()];
}

function selectRowsWithSelection(rows, query, label, { latest = false, first = false } = {}) {
  if (rows.length === 0) die(`no ${label} matched "${query}"`);
  if (latest && first) die(`cannot use both --latest and --first for ${label} lookup`);
  if (latest) return [sortRowsByRecency(rows, "desc")[0]];
  if (first) return [sortRowsByRecency(rows, "asc")[0]];
  if (rows.length === 1) return rows;
  die(`multiple ${label} matched "${query}": ${rows.map((row) => row.title).join(", ")}`);
}

function selectRowsWithLiveFallback(kind, query, label, options = {}) {
  const freshMatches = liveMatchesWithRetry(kind, query, options);
  if (freshMatches.length > 0) return selectRowsWithSelection(freshMatches, query, label, options);

  const cachedRows = mirrorRows(kind);
  const cachedMatches = matchingRows(cachedRows, query, options);
  return selectRowsWithSelection(cachedMatches, query, label, options);
}

export function searchRowsWithLiveFallback(kind, query, options = {}) {
  const freshMatches = liveMatchesWithRetry(kind, query, options);
  const visibleFreshMatches = filterArchivedMatches(freshMatches, options);
  if (visibleFreshMatches.length > 0) return visibleFreshMatches;

  const cachedRows = mirrorRows(kind);
  const cachedMatches = matchingRows(cachedRows, query, options);
  return filterArchivedMatches(cachedMatches, options);
}

export function searchTasks(args) {
  if (args["page-id"]) {
    return [getPage(args["page-id"])];
  }
  const spec = taskQuerySpec(args);
  if (!spec.query) die("missing task query");
  const matches = searchRowsWithLiveFallback("tasks", spec.query, { exact: spec.exact });
  if (matches.length === 0) die(`no task matched "${spec.query}"`);
  if (spec.latest || spec.first) {
    return selectRowsWithSelection(matches, spec.query, "task", spec);
  }
  return matches;
}

export function findTask(args) {
  if (args["page-id"]) {
    return getPage(args["page-id"]);
  }
  const spec = taskQuerySpec(args);
  if (!spec.query) die("missing task query");
  const matches = searchRowsWithLiveFallback("tasks", spec.query, { exact: spec.exact });
  return selectRowsWithSelection(matches, spec.query, "task", spec)[0];
}

export function taskQueryLabel(args) {
  return taskQuerySpec(args).query || null;
}

export function taskQueryOptions(args) {
  const spec = taskQuerySpec(args);
  return {
    exact: spec.exact,
    latest: spec.latest,
    first: spec.first,
    include_archived: spec.includeArchived
  };
}

function selectRowsWithLiveFallbackForTasks(args) {
  const spec = taskQuerySpec(args);
  if (!spec.query) die("missing task query");
  return selectRowsWithLiveFallback("tasks", spec.query, "task", {
    exact: spec.exact,
    latest: spec.latest,
    first: spec.first,
    includeArchived: spec.includeArchived
  });
}

function selectRowsWithLiveFallbackForMany(args) {
  const spec = taskQuerySpec(args);
  if (!spec.query) die("missing task query");
  const freshMatches = searchRowsWithLiveFallback("tasks", spec.query, {
    exact: spec.exact,
    includeArchived: spec.includeArchived
  });
  if (freshMatches.length === 0) die(`no task matched "${spec.query}"`);
  return freshMatches;
}

function filterArchivedMatches(rows, options = {}) {
  if (options.includeArchived) return rows;
  return rows
    .map((row) => {
      try {
        return getPage(row.id);
      } catch {
        return row;
      }
    })
    .filter((row) => !isArchivedTask(row));
}

export function matchTask(args) {
  return findTask(args);
}

export function matchTasks(args) {
  if (args["page-id"]) {
    return [getPage(args["page-id"])];
  }
  const spec = taskQuerySpec(args);
  if (spec.latest || spec.first) {
    return selectRowsWithLiveFallbackForTasks(args);
  }
  return selectRowsWithLiveFallbackForMany(args);
}

export function isDoneTask(task) {
  return (
    isArchivedTask(task) ||
    task.properties[TASK_FIELDS.status] === "done" ||
    task.properties[TASK_FIELDS.stage] === "done"
  );
}

export function isArchivedTask(task) {
  return (
    task.archived === true ||
    task.properties[TASK_FIELDS.stage] === "archived"
  );
}

export function isNonRecurringOneTimeTask(task) {
  return (
    task.properties[TASK_FIELDS.type] === "one_time" &&
    repeatModeOf(task) === "none"
  );
}

export function hasCalendarFields(task) {
  return Boolean(
    dateStart(task.properties[TASK_FIELDS.scheduledStart]) ||
      dateStart(task.properties[TASK_FIELDS.scheduledEnd]) ||
      calendarRefsOf(task).length > 0
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
