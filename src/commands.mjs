import { TASK_FIELDS } from "./config.mjs";
import { createCalendarEvent, deleteCalendarEvent, fetchCalendarEvent, updateCalendarEvent } from "./calendar.mjs";
import { dateStart, logCompletion } from "./history.mjs";
import {
  archivePage,
  getPage,
  kickMirrorSync,
  notionRequest,
  runMirrorSync,
  updatePageProperties
} from "./notion.mjs";
import {
  board,
  calendarRefsOf,
  classifyHorizonMove,
  clearCalendarProperties,
  defaultStageForTask,
  defaultHorizonForCadence,
  encodeCalendarRefs,
  findTask,
  findReusableTaskCandidate,
  inferHorizon,
  inferNeedsCalendar,
  inferRepeatModeFromShape,
  inferTypeFromShape,
  isNonRecurringOneTimeTask,
  listRows,
  matchTask,
  matchTasks,
  mirrorRows,
  plusCadence,
  primaryCalendarRefOf,
  repeatModeOf,
  resolveRelationArg,
  resolveTaskView,
  searchTasks,
  taskLookupSummary,
  taskQueryLabel,
  taskQueryOptions,
  summary
} from "./tasks.mjs";
import {
  addDays,
  boolOrNull,
  checkboxProperty,
  dateProperty,
  isoDate,
  multiSelectProperty,
  normalizeDateArg,
  numberProperty,
  relationProperty,
  richTextProperty,
  selectProperty,
  titleProperty
} from "./util.mjs";

function parseRepeatDaysArg(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isDateOnlyValue(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function resolveScheduleRange(label, start, end, { requireBoth = false } = {}) {
  if (requireBoth && (!start || !end)) {
    if (start && !end && isDateOnlyValue(start)) return { start, end: start, allDay: true };
    throw new Error(`${label} requires both start and end`);
  }
  if (!start && !end) return { start: null, end: null, allDay: false };
  if (!start || !end) {
    if (start && !end && isDateOnlyValue(start)) return { start, end: start, allDay: true };
    throw new Error(`${label} requires both start and end when setting calendar timing`);
  }
  const startDateOnly = isDateOnlyValue(start);
  const endDateOnly = isDateOnlyValue(end);
  if (startDateOnly !== endDateOnly) {
    throw new Error(`${label} requires start and end to both be datetimes or both be date-only values`);
  }
  if (startDateOnly && endDateOnly) {
    if (end < start) throw new Error(`${label} requires end to be on or after start`);
    return { start, end, allDay: true };
  }
  const startTs = Date.parse(start);
  const endTs = Date.parse(end);
  if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
    throw new Error(`${label} received an invalid ISO datetime`);
  }
  if (endTs <= startTs) {
    throw new Error(`${label} requires end to be after start`);
  }
  return { start, end, allDay: false };
}

function assertScheduleRange(label, start, end, options = {}) {
  resolveScheduleRange(label, start, end, options);
}

function normalizedInstant(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

function deleteCalendarRefs(task) {
  const refs = calendarRefsOf(task);
  for (const ref of refs) {
    if (ref.event_id) deleteCalendarEvent(ref.event_id);
  }
  return refs;
}

function eventStorageForRefs(refs) {
  const ordered = (refs || [])
    .filter((ref) => ref?.event_id)
    .sort((a, b) => Date.parse(a.start || "") - Date.parse(b.start || ""));
  const first = ordered[0] || null;
  return {
    refs: ordered,
    first
  };
}

const WEEKDAY_TO_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const WEEKDAY_TO_RRULE = {
  sunday: "SU",
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA"
};

function startOfWeek(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - value.getUTCDay());
  return value.toISOString().slice(0, 10);
}

function repeatAnchorDate({ repeatMode = null, cadence = null, repeatWindow = null, baseDate }) {
  if (!baseDate) return null;
  if (repeatMode === "manual_repeat") {
    if (repeatWindow === "week") return startOfWeek(baseDate);
    if (repeatWindow === "month") return `${baseDate.slice(0, 7)}-01`;
    if (repeatWindow === "year") return `${baseDate.slice(0, 4)}-01-01`;
    return baseDate;
  }
  if (repeatMode === "cadence" && cadence && cadence !== "none") {
    if (cadence === "monthly") return `${baseDate.slice(0, 7)}-01`;
    if (cadence === "weekly") return startOfWeek(baseDate);
    return baseDate;
  }
  return null;
}

function parseWeekdayList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      if (!(part in WEEKDAY_TO_INDEX)) {
        throw new Error(`invalid weekday: ${part}`);
      }
      return part;
    });
}

function parseClock(value, label) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${label} must be HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`${label} must be HH:MM`);
  return hours * 60 + minutes;
}

function timeZoneOffsetForDate(date, timeZone = "Asia/Jerusalem") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const zoneName = parts.find((part) => part.type === "timeZoneName")?.value || "GMT+0";
  const match = zoneName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return "+00:00";
  const [, sign, hours, minutes] = match;
  return `${sign}${String(hours).padStart(2, "0")}:${minutes || "00"}`;
}

function isoLocal(date, totalMinutes, timeZone = "Asia/Jerusalem") {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${date}T${hours}:${minutes}:00${timeZoneOffsetForDate(date, timeZone)}`;
}

function weekdayIndex(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function firstMatchingDate(fromDate, toDate, weekdays) {
  let cursor = fromDate;
  while (cursor <= toDate) {
    if (weekdays.includes(weekdayIndex(cursor))) return cursor;
    cursor = addDays(cursor, 1);
  }
  return null;
}

function untilStamp(date, endMinutes, timeZone = "Asia/Jerusalem") {
  const iso = isoLocal(date, endMinutes, timeZone);
  return new Date(Date.parse(iso)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function seriesScheduleSpec(task, args) {
  const fromDate = normalizeDateArg(args["from-date"] || args.date || "today");
  const toDate = normalizeDateArg(args["to-date"] || fromDate);
  if (toDate < fromDate) throw new Error("set-series-schedule requires to-date on or after from-date");
  const weekdayNames = parseWeekdayList(args.days || (task.properties[TASK_FIELDS.repeatDays] || []).join(","));
  if (weekdayNames.length === 0) {
    throw new Error("set-series-schedule requires --days or task Repeat Days");
  }
  const weekdayIndexes = weekdayNames.map((name) => WEEKDAY_TO_INDEX[name]);
  const startMinutes = parseClock(args["start-time"], "start-time");
  const endMinutes = parseClock(args["end-time"], "end-time");
  if (endMinutes <= startMinutes) throw new Error("set-series-schedule requires end-time after start-time");
  const timeZone = args["time-zone"] || "Asia/Jerusalem";
  const firstDate = firstMatchingDate(fromDate, toDate, weekdayIndexes);
  if (!firstDate) {
    throw new Error("set-series-schedule found no matching date in the requested range");
  }
  const start = isoLocal(firstDate, startMinutes, timeZone);
  const end = isoLocal(firstDate, endMinutes, timeZone);
  const byDay = weekdayNames.map((name) => WEEKDAY_TO_RRULE[name]).join(",");
  const rule = `RRULE:FREQ=WEEKLY;BYDAY=${byDay};UNTIL=${untilStamp(toDate, endMinutes, timeZone)}`;

  return {
    fromDate,
    toDate,
    weekday_names: weekdayNames,
    start,
    end,
    rrule: rule
  };
}

function multiScheduleSpec(args) {
  const raw = String(args.slots || "").trim();
  if (!raw) throw new Error("set-multi-schedule requires --slots");
  const refs = raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start, end] = part.split("|").map((value) => value?.trim() || "");
      assertScheduleRange("set-multi-schedule", start, end, { requireBoth: true });
      return { start, end };
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (refs.length === 0) throw new Error("set-multi-schedule requires at least one slot");
  return refs;
}

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function lookupResultPayload(action, rows, extra = {}) {
  return {
    ok: true,
    action,
    query: taskQueryLabel(extra.args || {}) || null,
    selectors: taskQueryOptions(extra.args || {}),
    count: rows.length,
    rows: rows.map(taskLookupSummary),
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "args"))
  };
}

function pushCheck(checks, name, expected, actual) {
  if (expected === undefined) return;
  checks.push({
    name,
    expected,
    actual,
    ok: expected === actual
  });
}

function verifyTaskState(pageId, {
  expected = {},
  priorCalendarEventId = null
} = {}) {
  const task = getPage(pageId);
  const taskStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  const taskEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
  const refs = calendarRefsOf(task);
  const currentEventId = refs[0]?.event_id || "";
  const linked = refs.length > 0;
  const scheduled = Boolean(taskStart) && Boolean(taskEnd);
  const lookupEventId = currentEventId || priorCalendarEventId || "";

  let lookup = null;
  let event = null;
  if (lookupEventId) {
    lookup = fetchCalendarEvent(lookupEventId);
    if (lookup.ok) event = lookup.event || null;
  }

  const calendarStart = event?.start?.dateTime || event?.start?.date || null;
  const calendarEnd = event?.end?.dateTime || event?.end?.date || null;
  const calendarStatus = event?.status || (lookup?.notFound ? "not_found" : null);
  const refsSynced = refs.every((ref) => {
    if (!ref.event_id) return false;
    const refLookup = fetchCalendarEvent(ref.event_id);
    if (!refLookup.ok) return false;
    const refEvent = refLookup.event || null;
    if (!refEvent || refEvent.status === "cancelled") return false;
    const refStart = refEvent.start?.dateTime || refEvent.start?.date || null;
    const refEnd = refEvent.end?.dateTime || refEvent.end?.date || null;
    return normalizedInstant(ref.start || taskStart) === normalizedInstant(refStart)
      && normalizedInstant(ref.end || taskEnd) === normalizedInstant(refEnd);
  });
  const scheduleSynced =
    linked &&
    scheduled &&
    (refs.length > 1
      ? refsSynced
      : Boolean(event) &&
        calendarStatus !== "cancelled" &&
        normalizedInstant(taskStart) === normalizedInstant(calendarStart) &&
        normalizedInstant(taskEnd) === normalizedInstant(calendarEnd));

  const actual = {
    ...taskLookupSummary(task),
    linked,
    scheduled,
    schedule_synced: scheduleSynced,
    calendar_event_ids: refs.map((ref) => ref.event_id),
    calendar_lookup_event_id: lookupEventId || null,
    calendar_event_status: calendarStatus,
    calendar_start: calendarStart,
    calendar_end: calendarEnd,
    lookup_ok: lookup ? lookup.ok === true : null,
    not_found: lookup ? Boolean(lookup.notFound) : false
  };

  const checks = [];
  pushCheck(checks, "archived", expected.archived, actual.archived);
  pushCheck(checks, "scheduled", expected.scheduled, actual.scheduled);
  pushCheck(checks, "linked", expected.linked, actual.linked);
  pushCheck(checks, "stage", expected.stage, actual.stage);
  pushCheck(checks, "status", expected.status, actual.status);
  pushCheck(checks, "horizon", expected.horizon, actual.horizon);
  pushCheck(checks, "schedule_state", expected.schedule_state, actual.schedule_state);
  pushCheck(checks, "schedule_synced", expected.schedule_synced, actual.schedule_synced);
  pushCheck(checks, "calendar_event_status", expected.calendar_event_status, actual.calendar_event_status);
  pushCheck(checks, "calendar_event_id", expected.calendar_event_id, actual.calendar_event_id);

  return {
    ok: true,
    action: "verify-task",
    page_id: task.id,
    task: task.title,
    verified: checks.every((check) => check.ok),
    expected,
    actual,
    checks
  };
}

function verifyFlagEnabled(args) {
  return args.verify === true || args.verify === "true";
}

function duplicateReuseAllowed(args) {
  return args["allow-duplicate"] === true || args["allow-duplicate"] === "true";
}

function taskCreateOrReuseResult(action, {
  pageId,
  title,
  requestedTitle,
  reusedExisting = false,
  reuseReason = null,
  calendarEventId = null,
  updatesApplied = false,
  inferred = undefined
}) {
  return {
    ok: true,
    action,
    page_id: pageId,
    title,
    requested_title: requestedTitle,
    reused_existing: reusedExisting,
    reuse_reason: reuseReason,
    updates_applied: updatesApplied,
    calendar_event_id: calendarEventId,
    ...(inferred === undefined ? {} : { inferred })
  };
}

function expectedVerifyArgs(args) {
  return {
    archived: args.archived === undefined ? undefined : boolOrNull(args.archived),
    scheduled: args.scheduled === undefined ? undefined : boolOrNull(args.scheduled),
    linked: args.linked === undefined ? undefined : boolOrNull(args.linked),
    stage: args.stage || undefined,
    status: args.status || undefined,
    horizon: args.horizon || undefined,
    schedule_state: args["schedule-state"] || undefined,
    schedule_synced: args["schedule-synced"] === undefined ? undefined : boolOrNull(args["schedule-synced"]),
    calendar_event_status: args["calendar-event-status"] || undefined,
    calendar_event_id: args["calendar-event-id"] || undefined
  };
}

export function cmdShow(args) {
  const rows = mirrorRows("tasks");
  const rawView = args.view || "today";
  const { view, spec } = resolveTaskView(rawView);
  const result = rows.filter(spec.filter).map(summary);
  console.log(JSON.stringify({ view, count: result.length, rows: result }, null, 2));
}

export function cmdInspectTask(args) {
  const task = matchTask(args);
  emitJson(task);
}

export function cmdFindTask(args) {
  const task = findTask(args);
  emitJson({
    ...lookupResultPayload("find-task", [task], { args }),
    row: taskLookupSummary(task)
  });
}

export function cmdSearchTasks(args) {
  const tasks = searchTasks(args);
  emitJson(lookupResultPayload("search-tasks", tasks, { args }));
}

export function cmdVerifyTask(args) {
  const task = matchTask(args);
  const expected = expectedVerifyArgs(args);
  const verification = verifyTaskState(task.id, {
    expected,
    priorCalendarEventId: args["prior-event-id"] || null
  });
  emitJson(verification);
}

export function cmdAddTask(args) {
  const b = board();
  const title = args.title || args._.join(" ");
  if (!title) throw new Error('usage: add-task --title "..." [--horizon ...]');
  const baseDate = normalizeDateArg(args.date);
  const repeatMode = inferRepeatModeFromShape({
    repeatMode: args["repeat-mode"],
    type: args.type,
    cadence: args.cadence
  });
  const repeatDays = parseRepeatDaysArg(args["repeat-days"]);
  const type = inferTypeFromShape({
    type: args.type,
    repeatMode,
    cadence: args.cadence
  });
  const implicitDueDate = repeatAnchorDate({
    repeatMode,
    cadence: args.cadence || null,
    repeatWindow: args["repeat-window"] || null,
    baseDate
  });
  const dueDate = isoDate(args["due-date"] || implicitDueDate || null);
  const nextDueAt = isoDate(args["next-due-at"] || dueDate || null);
  const projectIds = resolveRelationArg("projects", args, "project", "project-id");
  const goalIds = resolveRelationArg("goals", args, "goal", "goal-id");
  const reusableTask = duplicateReuseAllowed(args) ? null : findReusableTaskCandidate(title);

  if (reusableTask) {
    const updates = {
      [TASK_FIELDS.stage]: args.stage ? selectProperty(args.stage) : undefined,
      [TASK_FIELDS.status]: args.status ? selectProperty(args.status) : undefined,
      [TASK_FIELDS.horizon]: args.horizon ? selectProperty(args.horizon) : undefined,
      [TASK_FIELDS.type]: args.type ? selectProperty(type) : undefined,
      [TASK_FIELDS.repeatMode]: args["repeat-mode"] ? selectProperty(repeatMode) : undefined,
      [TASK_FIELDS.priority]: args.priority ? selectProperty(args.priority) : undefined,
      [TASK_FIELDS.needsCalendar]:
        args["needs-calendar"] !== undefined ? checkboxProperty(boolOrNull(args["needs-calendar"])) : undefined,
      [TASK_FIELDS.schedulingMode]:
        args["scheduling-mode"] ? selectProperty(args["scheduling-mode"]) : undefined,
      [TASK_FIELDS.scheduleType]: args["schedule-type"] ? selectProperty(args["schedule-type"]) : undefined,
      [TASK_FIELDS.estimatedMinutes]:
        args["estimated-minutes"] === undefined ? undefined : numberProperty(args["estimated-minutes"]),
      [TASK_FIELDS.energy]: args.energy ? selectProperty(args.energy) : undefined,
      [TASK_FIELDS.cadence]: args.cadence ? selectProperty(args.cadence) : undefined,
      [TASK_FIELDS.repeatWindow]: args["repeat-window"] ? selectProperty(args["repeat-window"]) : undefined,
      [TASK_FIELDS.repeatTargetCount]:
        args["repeat-target-count"] === undefined ? undefined : numberProperty(args["repeat-target-count"]),
      [TASK_FIELDS.repeatProgress]:
        args["repeat-progress"] === undefined ? undefined : numberProperty(args["repeat-progress"]),
      [TASK_FIELDS.repeatDays]: args["repeat-days"] ? multiSelectProperty(repeatDays) : undefined,
      [TASK_FIELDS.dueDate]: args["due-date"] ? dateProperty(dueDate) : undefined,
      [TASK_FIELDS.nextDueAt]: args["next-due-at"] ? dateProperty(nextDueAt) : undefined,
      [TASK_FIELDS.reviewNotes]: args.notes ? richTextProperty(args.notes) : undefined,
      [TASK_FIELDS.project]:
        args.project || args["project-id"] ? relationProperty(projectIds) : undefined,
      [TASK_FIELDS.goal]:
        args.goal || args["goal-id"] ? relationProperty(goalIds) : undefined
    };
    const filtered = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
    if (Object.keys(filtered).length > 0) updatePageProperties(reusableTask.id, filtered);
    emitJson(taskCreateOrReuseResult("add-task", {
      pageId: reusableTask.id,
      title: reusableTask.title,
      requestedTitle: title,
      reusedExisting: true,
      reuseReason: reusableTask.reuse_match?.reason || null,
      updatesApplied: Object.keys(filtered).length > 0
    }));
    return;
  }

  const payload = {
    parent: { data_source_id: b.databases.tasks.data_source_id },
    properties: {
      [TASK_FIELDS.title]: titleProperty(title),
      [TASK_FIELDS.stage]: selectProperty(args.stage || "inbox"),
      [TASK_FIELDS.status]: selectProperty(args.status || "todo"),
      [TASK_FIELDS.horizon]: selectProperty(args.horizon || "this week"),
      [TASK_FIELDS.type]: selectProperty(type),
      [TASK_FIELDS.repeatMode]: selectProperty(repeatMode),
      [TASK_FIELDS.priority]: selectProperty(args.priority || "medium"),
      [TASK_FIELDS.needsCalendar]: checkboxProperty(boolOrNull(args["needs-calendar"]) ?? false),
      [TASK_FIELDS.schedulingMode]: selectProperty(args["scheduling-mode"] || null),
      [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || null),
      [TASK_FIELDS.estimatedMinutes]: numberProperty(args["estimated-minutes"]),
      [TASK_FIELDS.energy]: selectProperty(args.energy || null),
      [TASK_FIELDS.cadence]: selectProperty(args.cadence || null),
      [TASK_FIELDS.repeatWindow]: selectProperty(args["repeat-window"] || null),
      [TASK_FIELDS.repeatTargetCount]: numberProperty(args["repeat-target-count"]),
      [TASK_FIELDS.repeatProgress]: numberProperty(args["repeat-progress"]),
      [TASK_FIELDS.repeatDays]: multiSelectProperty(repeatDays),
      [TASK_FIELDS.dueDate]: dateProperty(dueDate),
      [TASK_FIELDS.nextDueAt]: dateProperty(nextDueAt),
      [TASK_FIELDS.reviewNotes]: richTextProperty(args.notes || ""),
      [TASK_FIELDS.project]: relationProperty(projectIds),
      [TASK_FIELDS.goal]: relationProperty(goalIds)
    }
  };

  const out = notionRequest("POST", "/v1/pages", payload, true);
  kickMirrorSync();
  emitJson(taskCreateOrReuseResult("add-task", {
    pageId: out.id,
    title,
    requestedTitle: title
  }));
}

export function cmdCapture(args) {
  const b = board();
  const title = args.title || args._.join(" ");
  if (!title) throw new Error('usage: capture --title "..." [--project "..."] [--goal "..."]');
  const schedule = resolveScheduleRange("capture", args.start, args.end);
  const baseDate = normalizeDateArg(args.date);

  const repeatMode = inferRepeatModeFromShape({
    repeatMode: args["repeat-mode"],
    type: args.type,
    cadence: args.cadence
  });
  const repeatDays = parseRepeatDaysArg(args["repeat-days"]);
  const type = inferTypeFromShape({
    type: args.type || null,
    repeatMode,
    cadence: args.cadence || null
  });
  const implicitDueDate = repeatAnchorDate({
    repeatMode,
    cadence: args.cadence || null,
    repeatWindow: args["repeat-window"] || null,
    baseDate
  });
  const dueDate = isoDate(args["due-date"] || implicitDueDate || null);
  const nextDueAt = isoDate(args["next-due-at"] || dueDate || null);
  const projectIds = resolveRelationArg("projects", args, "project", "project-id");
  const goalIds = resolveRelationArg("goals", args, "goal", "goal-id");
  const explicitNeedsCalendar = boolOrNull(args["needs-calendar"]);
  const draft = {
    properties: {
      [TASK_FIELDS.title]: title,
      [TASK_FIELDS.type]: type,
      [TASK_FIELDS.repeatMode]: repeatMode,
      [TASK_FIELDS.priority]: args.priority || "medium",
      [TASK_FIELDS.estimatedMinutes]:
        args["estimated-minutes"] === undefined ? null : Number(args["estimated-minutes"]),
      [TASK_FIELDS.energy]: args.energy || null,
      [TASK_FIELDS.cadence]: args.cadence || null,
      [TASK_FIELDS.repeatWindow]: args["repeat-window"] || null,
      [TASK_FIELDS.repeatTargetCount]:
        args["repeat-target-count"] === undefined ? null : Number(args["repeat-target-count"]),
      [TASK_FIELDS.repeatProgress]:
        args["repeat-progress"] === undefined ? null : Number(args["repeat-progress"]),
      [TASK_FIELDS.repeatDays]: repeatDays,
      [TASK_FIELDS.dueDate]: dueDate ? { start: dueDate, end: null, time_zone: null } : null,
      [TASK_FIELDS.project]: projectIds,
      [TASK_FIELDS.goal]: goalIds,
      [TASK_FIELDS.needsCalendar]: explicitNeedsCalendar,
      [TASK_FIELDS.schedulingMode]: args["scheduling-mode"] || null,
      [TASK_FIELDS.scheduledStart]: schedule.start ? { start: schedule.start, end: null, time_zone: null } : null,
      [TASK_FIELDS.scheduledEnd]: schedule.end ? { start: schedule.end, end: null, time_zone: null } : null,
      [TASK_FIELDS.stage]: args.stage || null,
      [TASK_FIELDS.status]: args.status || null,
      [TASK_FIELDS.horizon]: args.horizon || null
    }
  };

  const inferredHorizon = args.horizon || inferHorizon(draft);
  const inferredNeedsCalendar =
    schedule.start && schedule.end
      ? true
      : (explicitNeedsCalendar ??
        inferNeedsCalendar({
          properties: {
            ...draft.properties,
            [TASK_FIELDS.horizon]: inferredHorizon
          }
        }));
  const inferredStage =
    args.stage ||
    (args.inbox === true
      ? "inbox"
      : defaultStageForTask({
          properties: {
            ...draft.properties,
            [TASK_FIELDS.horizon]: inferredHorizon,
            [TASK_FIELDS.needsCalendar]: inferredNeedsCalendar
          }
        }, inferredHorizon));
  const inferredStatus =
    args.status ||
    (inferredStage === "blocked"
      ? "blocked"
      : schedule.start && schedule.end
        ? "scheduled"
        : "todo");
  const reusableTask = duplicateReuseAllowed(args) ? null : findReusableTaskCandidate(title);
  let scheduledEvent = null;
  if (schedule.start && schedule.end && !reusableTask) {
    scheduledEvent = createCalendarEvent(title, schedule.start, schedule.end);
  }
  const inferredSchedulingMode = args["scheduling-mode"] || (scheduledEvent ? "flexible_block" : null);
  const inferredScheduleType = args["schedule-type"] || (scheduledEvent ? "soft" : null);

  if (reusableTask) {
    let calendarEventIdUpdate;
    if (schedule.start && schedule.end) {
      const refs = calendarRefsOf(reusableTask);
      const reusableRef = refs.length === 1 ? refs[0] : null;
      if (!reusableRef && refs.length > 1) deleteCalendarRefs(reusableTask);
      scheduledEvent = reusableRef
        ? updateCalendarEvent(reusableRef.event_id, reusableTask.title, schedule.start, schedule.end)
        : createCalendarEvent(reusableTask.title, schedule.start, schedule.end);
      calendarEventIdUpdate = encodeCalendarRefs([{
        event_id: scheduledEvent.id,
        start: schedule.start,
        end: schedule.end
      }]);
    }

    const updates = {
      [TASK_FIELDS.stage]: selectProperty(inferredStage),
      [TASK_FIELDS.status]: selectProperty(inferredStatus),
      [TASK_FIELDS.horizon]: selectProperty(inferredHorizon),
      [TASK_FIELDS.needsCalendar]: checkboxProperty(inferredNeedsCalendar),
      [TASK_FIELDS.type]: args.type ? selectProperty(type) : undefined,
      [TASK_FIELDS.repeatMode]: args["repeat-mode"] ? selectProperty(repeatMode) : undefined,
      [TASK_FIELDS.priority]: args.priority ? selectProperty(args.priority) : undefined,
      [TASK_FIELDS.schedulingMode]:
        schedule.start && schedule.end
          ? selectProperty(args["scheduling-mode"] || "flexible_block")
          : args["scheduling-mode"]
            ? selectProperty(args["scheduling-mode"])
            : undefined,
      [TASK_FIELDS.scheduleType]:
        schedule.start && schedule.end
          ? selectProperty(args["schedule-type"] || "soft")
          : args["schedule-type"]
            ? selectProperty(args["schedule-type"])
            : undefined,
      [TASK_FIELDS.estimatedMinutes]:
        args["estimated-minutes"] === undefined ? undefined : numberProperty(args["estimated-minutes"]),
      [TASK_FIELDS.energy]: args.energy ? selectProperty(args.energy) : undefined,
      [TASK_FIELDS.cadence]: args.cadence ? selectProperty(args.cadence) : undefined,
      [TASK_FIELDS.repeatWindow]: args["repeat-window"] ? selectProperty(args["repeat-window"]) : undefined,
      [TASK_FIELDS.repeatTargetCount]:
        args["repeat-target-count"] === undefined ? undefined : numberProperty(args["repeat-target-count"]),
      [TASK_FIELDS.repeatProgress]:
        args["repeat-progress"] === undefined ? undefined : numberProperty(args["repeat-progress"]),
      [TASK_FIELDS.repeatDays]: args["repeat-days"] ? multiSelectProperty(repeatDays) : undefined,
      [TASK_FIELDS.dueDate]: args["due-date"] ? dateProperty(dueDate) : undefined,
      [TASK_FIELDS.nextDueAt]: args["next-due-at"] ? dateProperty(nextDueAt) : undefined,
      [TASK_FIELDS.reviewNotes]: args.notes ? richTextProperty(args.notes) : undefined,
      [TASK_FIELDS.project]:
        args.project || args["project-id"] ? relationProperty(projectIds) : undefined,
      [TASK_FIELDS.goal]:
        args.goal || args["goal-id"] ? relationProperty(goalIds) : undefined,
      [TASK_FIELDS.scheduledStart]: schedule.start ? dateProperty(schedule.start) : undefined,
      [TASK_FIELDS.scheduledEnd]: schedule.end ? dateProperty(schedule.end) : undefined,
      [TASK_FIELDS.calendarEventId]: calendarEventIdUpdate
    };

    updatePageProperties(reusableTask.id, updates);
    const result = taskCreateOrReuseResult("capture", {
      pageId: reusableTask.id,
      title: reusableTask.title,
      requestedTitle: title,
      reusedExisting: true,
      reuseReason: reusableTask.reuse_match?.reason || null,
      calendarEventId: scheduledEvent?.id || null,
      updatesApplied: true,
      inferred: {
        horizon: inferredHorizon,
        stage: inferredStage,
        status: inferredStatus,
        needs_calendar: inferredNeedsCalendar,
        repeat_mode: repeatMode,
        repeat_window: args["repeat-window"] || null,
        repeat_target_count: args["repeat-target-count"] === undefined ? null : Number(args["repeat-target-count"]),
        repeat_days: repeatDays,
        scheduling_mode:
          (schedule.start && schedule.end ? args["scheduling-mode"] || "flexible_block" : args["scheduling-mode"]) || null,
        schedule_type:
          (schedule.start && schedule.end ? args["schedule-type"] || "soft" : args["schedule-type"]) || null,
        project_ids: projectIds,
        goal_ids: goalIds
      }
    });

    if (verifyFlagEnabled(args)) {
      result.verification = verifyTaskState(reusableTask.id, {
        expected: scheduledEvent
          ? {
              archived: false,
              scheduled: true,
              linked: true,
              schedule_synced: true,
              calendar_event_id: scheduledEvent.id
            }
          : {
              archived: false,
              horizon: inferredHorizon
            }
      });
      result.verified = result.verification.verified;
    }

    emitJson(result);
    return;
  }

  const payload = {
    parent: { data_source_id: b.databases.tasks.data_source_id },
    properties: {
      [TASK_FIELDS.title]: titleProperty(title),
      [TASK_FIELDS.stage]: selectProperty(inferredStage),
      [TASK_FIELDS.status]: selectProperty(inferredStatus),
      [TASK_FIELDS.horizon]: selectProperty(inferredHorizon),
      [TASK_FIELDS.type]: selectProperty(type),
      [TASK_FIELDS.repeatMode]: selectProperty(repeatMode),
      [TASK_FIELDS.priority]: selectProperty(args.priority || "medium"),
      [TASK_FIELDS.needsCalendar]: checkboxProperty(inferredNeedsCalendar),
      [TASK_FIELDS.schedulingMode]: selectProperty(inferredSchedulingMode),
      [TASK_FIELDS.scheduleType]: selectProperty(inferredScheduleType),
      [TASK_FIELDS.estimatedMinutes]: numberProperty(args["estimated-minutes"]),
      [TASK_FIELDS.energy]: selectProperty(args.energy || null),
      [TASK_FIELDS.cadence]: selectProperty(args.cadence || null),
      [TASK_FIELDS.repeatWindow]: selectProperty(args["repeat-window"] || null),
      [TASK_FIELDS.repeatTargetCount]: numberProperty(args["repeat-target-count"]),
      [TASK_FIELDS.repeatProgress]: numberProperty(args["repeat-progress"]),
      [TASK_FIELDS.repeatDays]: multiSelectProperty(repeatDays),
      [TASK_FIELDS.dueDate]: dateProperty(dueDate),
      [TASK_FIELDS.nextDueAt]: dateProperty(nextDueAt),
      [TASK_FIELDS.reviewNotes]: richTextProperty(args.notes || ""),
      [TASK_FIELDS.project]: relationProperty(projectIds),
      [TASK_FIELDS.goal]: relationProperty(goalIds),
      [TASK_FIELDS.scheduledStart]: dateProperty(schedule.start || null),
      [TASK_FIELDS.scheduledEnd]: dateProperty(schedule.end || null),
      [TASK_FIELDS.calendarEventId]: richTextProperty(scheduledEvent?.id || "")
    }
  };

  const out = notionRequest("POST", "/v1/pages", payload, true);
  kickMirrorSync();
  const result = taskCreateOrReuseResult("capture", {
    pageId: out.id,
    title,
    requestedTitle: title,
    calendarEventId: scheduledEvent?.id || null,
    inferred: {
      horizon: inferredHorizon,
      stage: inferredStage,
      status: inferredStatus,
      needs_calendar: inferredNeedsCalendar,
      repeat_mode: repeatMode,
      repeat_window: args["repeat-window"] || null,
      repeat_target_count: args["repeat-target-count"] === undefined ? null : Number(args["repeat-target-count"]),
      repeat_days: repeatDays,
      scheduling_mode: inferredSchedulingMode,
      schedule_type: inferredScheduleType,
      project_ids: projectIds,
      goal_ids: goalIds
    }
  });

  if (verifyFlagEnabled(args)) {
    result.verification = verifyTaskState(out.id, {
      expected: scheduledEvent
        ? {
            archived: false,
            scheduled: true,
            linked: true,
            schedule_synced: true,
            calendar_event_id: scheduledEvent.id
          }
        : {
            archived: false,
            horizon: inferredHorizon
          }
    });
    result.verified = result.verification.verified;
  }

  emitJson(result);
}

export function cmdMoveTask(args) {
  const task = matchTask(args);
  const schedule = resolveScheduleRange("move-task", args["scheduled-start"], args["scheduled-end"]);
  const hasScheduledStart = Boolean(schedule.start);
  const hasScheduledEnd = Boolean(schedule.end);

  let calendarEventIdUpdate;
  if (hasScheduledStart && hasScheduledEnd) {
    const refs = calendarRefsOf(task);
    const reusableRef = refs.length === 1 ? refs[0] : null;
    if (!reusableRef && refs.length > 1) deleteCalendarRefs(task);
    const event = reusableRef
      ? updateCalendarEvent(reusableRef.event_id, task.title, schedule.start, schedule.end)
      : createCalendarEvent(task.title, schedule.start, schedule.end);
    calendarEventIdUpdate = encodeCalendarRefs([{
      event_id: event.id,
      start: schedule.start,
      end: schedule.end
    }]);
  }

  updatePageProperties(task.id, {
    [TASK_FIELDS.horizon]: args.horizon ? selectProperty(args.horizon) : undefined,
    [TASK_FIELDS.stage]: args.stage ? selectProperty(args.stage) : undefined,
    [TASK_FIELDS.status]: args.status ? selectProperty(args.status) : undefined,
    [TASK_FIELDS.dueDate]: args["due-date"] ? dateProperty(args["due-date"]) : undefined,
    [TASK_FIELDS.scheduledStart]: hasScheduledStart ? dateProperty(schedule.start) : undefined,
    [TASK_FIELDS.scheduledEnd]: hasScheduledEnd ? dateProperty(schedule.end) : undefined,
    [TASK_FIELDS.needsCalendar]:
      hasScheduledStart && hasScheduledEnd
        ? checkboxProperty(true)
        : args["needs-calendar"] !== undefined
          ? checkboxProperty(boolOrNull(args["needs-calendar"]))
          : undefined,
    [TASK_FIELDS.schedulingMode]: args["scheduling-mode"] ? selectProperty(args["scheduling-mode"]) : undefined,
    [TASK_FIELDS.scheduleType]: args["schedule-type"] ? selectProperty(args["schedule-type"]) : undefined,
    [TASK_FIELDS.calendarEventId]: calendarEventIdUpdate
  });
  console.log(JSON.stringify({
    ok: true,
    action: "move-task",
    page_id: task.id,
    matched_task: task.title,
    changes: {
      horizon: args.horizon || null,
      stage: args.stage || null,
      status: args.status || null,
      due_date: args["due-date"] || null,
      scheduled_start: schedule.start || null,
      scheduled_end: schedule.end || null,
      needs_calendar: args["needs-calendar"] ?? null,
      scheduling_mode: args["scheduling-mode"] || null,
      schedule_type: args["schedule-type"] || null
    }
  }, null, 2));
}

export function cmdPromote(args) {
  const task = matchTask(args);
  const to = args.to || args.horizon;
  if (!to) throw new Error('usage: promote --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year');
  const targetStage =
    args.stage ||
    defaultStageForTask({
      ...task,
      properties: {
        ...task.properties,
        [TASK_FIELDS.horizon]: to,
        [TASK_FIELDS.needsCalendar]:
          args["needs-calendar"] !== undefined ? boolOrNull(args["needs-calendar"]) : task.properties[TASK_FIELDS.needsCalendar]
      }
    }, to);
  const nextStatus =
    args.status ||
    (targetStage === "blocked"
      ? "blocked"
      : task.properties[TASK_FIELDS.status] === "scheduled" && targetStage !== "planned"
        ? "todo"
        : task.properties[TASK_FIELDS.status] || "todo");

  updatePageProperties(task.id, {
    [TASK_FIELDS.horizon]: selectProperty(to),
    [TASK_FIELDS.stage]: selectProperty(targetStage),
    [TASK_FIELDS.status]: selectProperty(nextStatus),
    [TASK_FIELDS.needsCalendar]:
      args["needs-calendar"] !== undefined ? checkboxProperty(boolOrNull(args["needs-calendar"])) : undefined,
    [TASK_FIELDS.dueDate]: args["due-date"] ? dateProperty(args["due-date"]) : undefined
  });

  console.log(JSON.stringify({
    ok: true,
    action: "promote",
    page_id: task.id,
    task: task.title,
    from: task.properties[TASK_FIELDS.horizon] || null,
    to,
    direction: classifyHorizonMove(task.properties[TASK_FIELDS.horizon], to),
    stage: targetStage,
    status: nextStatus
  }, null, 2));
}

export function cmdDefer(args) {
  const task = matchTask(args);
  const to = args.to || args.horizon;
  if (!to) throw new Error('usage: defer --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year');
  const keepSchedule = args["keep-schedule"] === true;
  const nextMissCount =
    args["increment-miss"] === true ? Number(task.properties[TASK_FIELDS.missCount] || 0) + 1 : null;
  const targetStage =
    args.stage ||
    (task.properties[TASK_FIELDS.stage] === "blocked"
      ? "blocked"
      : "planned");
  const nextStatus =
    args.status ||
    (targetStage === "blocked" ? "blocked" : "todo");
  if (!keepSchedule) deleteCalendarRefs(task);

  updatePageProperties(task.id, {
    [TASK_FIELDS.horizon]: selectProperty(to),
    [TASK_FIELDS.stage]: selectProperty(targetStage),
    [TASK_FIELDS.status]: selectProperty(nextStatus),
    [TASK_FIELDS.dueDate]: args["due-date"] ? dateProperty(args["due-date"]) : undefined,
    [TASK_FIELDS.missCount]: nextMissCount === null ? undefined : numberProperty(nextMissCount),
    ...(keepSchedule ? {} : clearCalendarProperties())
  });

  console.log(JSON.stringify({
    ok: true,
    action: "defer",
    page_id: task.id,
    task: task.title,
    from: task.properties[TASK_FIELDS.horizon] || null,
    to,
    direction: classifyHorizonMove(task.properties[TASK_FIELDS.horizon], to),
    stage: targetStage,
    status: nextStatus,
    cleared_schedule: !keepSchedule,
    miss_count: nextMissCount
  }, null, 2));
}

export function cmdBlockTask(args) {
  const task = matchTask(args);
  if (!args.reason) throw new Error('usage: block-task --match "..." --reason "..."');
  updatePageProperties(task.id, {
    [TASK_FIELDS.stage]: selectProperty("blocked"),
    [TASK_FIELDS.status]: selectProperty("blocked"),
    [TASK_FIELDS.blockedBy]: richTextProperty(args.reason),
    [TASK_FIELDS.waitingOn]: richTextProperty(args["waiting-on"] || ""),
    [TASK_FIELDS.reviewNotes]: args.notes ? richTextProperty(args.notes) : undefined
  });
  console.log(JSON.stringify({ ok: true, action: "block-task", page_id: task.id, task: task.title }, null, 2));
}

export function cmdCompleteTask(args) {
  const task = matchTask(args);
  const when = normalizeDateArg(args.when);
  const cadence = task.properties[TASK_FIELDS.cadence];
  const repeatMode = repeatModeOf(task);
  const repeatTargetCount = Number(task.properties[TASK_FIELDS.repeatTargetCount] || 0);
  const repeatProgress = Number(task.properties[TASK_FIELDS.repeatProgress] || 0);
  const refs = calendarRefsOf(task);

  if (repeatMode === "cadence" && cadence && cadence !== "none") {
    deleteCalendarRefs(task);
    const next = plusCadence(when, cadence);
    logCompletion(task, {
      completed_at: when,
      mode: "recurring-roll-forward",
      next_due: next,
      source: "complete-task"
    });
    updatePageProperties(task.id, {
      [TASK_FIELDS.lastCompletedAt]: dateProperty(when),
      [TASK_FIELDS.nextDueAt]: dateProperty(next),
      [TASK_FIELDS.dueDate]: dateProperty(next),
      [TASK_FIELDS.horizon]: selectProperty(defaultHorizonForCadence(cadence) || task.properties[TASK_FIELDS.horizon] || "this week"),
      [TASK_FIELDS.status]: selectProperty("todo"),
      [TASK_FIELDS.stage]: selectProperty("active"),
      [TASK_FIELDS.scheduledStart]: dateProperty(null),
      [TASK_FIELDS.scheduledEnd]: dateProperty(null),
      [TASK_FIELDS.calendarEventId]: richTextProperty("")
    });
    console.log(JSON.stringify({ ok: true, action: "complete-task", mode: "recurring-roll-forward", task: task.title, next_due: next }, null, 2));
    return;
  }

  if (repeatMode === "manual_repeat") {
    if (repeatTargetCount > 0) {
      deleteCalendarRefs(task);
      const nextProgress = Math.min(repeatTargetCount, repeatProgress + 1);
      const reachedTarget = nextProgress >= repeatTargetCount;
      logCompletion(task, {
        completed_at: when,
        mode: reachedTarget ? "manual-repeat-window-complete" : "manual-repeat-progress",
        source: "complete-task",
        progress: nextProgress,
        target: repeatTargetCount
      });
      updatePageProperties(task.id, {
        [TASK_FIELDS.repeatProgress]: numberProperty(nextProgress),
        [TASK_FIELDS.lastCompletedAt]: dateProperty(when),
        [TASK_FIELDS.status]: selectProperty(reachedTarget ? "done" : "todo"),
        [TASK_FIELDS.stage]: selectProperty(reachedTarget ? "done" : task.properties[TASK_FIELDS.stage] || "active"),
        ...clearCalendarProperties()
      });
      console.log(JSON.stringify({
        ok: true,
        action: "complete-task",
        mode: reachedTarget ? "manual-repeat-window-complete" : "manual-repeat-progress",
        page_id: task.id,
        task: task.title,
        progress: nextProgress,
        target: repeatTargetCount
      }, null, 2));
      return;
    }

    logCompletion(task, {
      completed_at: when,
      mode: "manual-repeat-done",
      source: "complete-task"
    });
    deleteCalendarRefs(task);
    updatePageProperties(task.id, {
      [TASK_FIELDS.status]: selectProperty("done"),
      [TASK_FIELDS.stage]: selectProperty("done"),
      [TASK_FIELDS.lastCompletedAt]: dateProperty(when),
      [TASK_FIELDS.nextDueAt]: dateProperty(null),
      ...clearCalendarProperties()
    });
    console.log(JSON.stringify({
      ok: true,
      action: "complete-task",
      mode: "manual-repeat-done",
      page_id: task.id,
      task: task.title
    }, null, 2));
    return;
  }

  const archive = args.archive !== "false";
  if (archive) {
    logCompletion(task, {
      completed_at: when,
      mode: "archived",
      source: "complete-task"
    });
    deleteCalendarRefs(task);
    archivePage(task.id);
    console.log(JSON.stringify({ ok: true, action: "complete-task", mode: "archived", page_id: task.id, task: task.title }, null, 2));
    return;
  }

  logCompletion(task, {
    completed_at: when,
    mode: "done",
    source: "complete-task"
  });
  deleteCalendarRefs(task);
  updatePageProperties(task.id, {
    [TASK_FIELDS.status]: selectProperty("done"),
    [TASK_FIELDS.stage]: selectProperty("done"),
    [TASK_FIELDS.lastCompletedAt]: dateProperty(when)
  });
  console.log(JSON.stringify({ ok: true, action: "complete-task", mode: "done", page_id: task.id, task: task.title }, null, 2));
}

export function cmdArchiveTask(args) {
  const query = args.match || args.title || args._.join(" ");
  const shouldAllowMany =
    args["all-matches"] === true ||
    (!args["page-id"] && query && /[*?]/.test(String(query)));
  const tasks = shouldAllowMany ? matchTasks(args) : [matchTask(args)];
  const archived = [];

  for (const task of tasks) {
    const refs = deleteCalendarRefs(task);
    archivePage(task.id);
    archived.push({
      page_id: task.id,
      task: task.title,
      removed_calendar_event: refs.length > 0,
      calendar_event_id: refs[0]?.event_id || null,
      calendar_event_ids: refs.map((ref) => ref.event_id)
    });
  }

  if (archived.length === 1) {
    console.log(JSON.stringify({
      ok: true,
      action: "archive-task",
      ...archived[0]
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    action: "archive-task",
    mode: "multi-match",
    query: query || null,
    count: tasks.length,
    archived
  }, null, 2));
}

export function cmdDeleteTask(args) {
  const query = args.match || args.title || args._.join(" ");
  const shouldAllowMany =
    args["all-matches"] === true ||
    (!args["page-id"] && query && /[*?]/.test(String(query)));
  const tasks = shouldAllowMany ? matchTasks(args) : [matchTask(args)];
  const recurringAllowed = boolOrNull(args["allow-recurring"]) === true;
  const deleted = [];

  for (const task of tasks) {
    if (!recurringAllowed && !isNonRecurringOneTimeTask(task)) {
      throw new Error("delete-task only deletes non-recurring one-time tasks; use remove-schedule for calendar cleanup or pass --allow-recurring explicitly");
    }

    const refs = deleteCalendarRefs(task);
    const eventId = refs[0]?.event_id || "";
    if (task.properties[TASK_FIELDS.calendarEventId] || task.properties[TASK_FIELDS.scheduledStart] || task.properties[TASK_FIELDS.scheduledEnd]) {
      const clearedTask = {
        ...task,
        properties: {
          ...task.properties,
          [TASK_FIELDS.scheduledStart]: null,
          [TASK_FIELDS.scheduledEnd]: null,
          [TASK_FIELDS.calendarEventId]: ""
        }
      };
      updatePageProperties(task.id, {
        ...clearCalendarProperties(),
        [TASK_FIELDS.status]: selectProperty("todo"),
        [TASK_FIELDS.stage]: selectProperty(defaultStageForTask(clearedTask))
      });
    }
    archivePage(task.id);

    const result = {
      page_id: task.id,
      task: task.title,
      removed_calendar_event: refs.length > 0,
      calendar_event_id: eventId || null,
      calendar_event_ids: refs.map((ref) => ref.event_id),
      type: task.properties[TASK_FIELDS.type] || null,
      repeat_mode: repeatModeOf(task),
      archived: true
    };

    if (verifyFlagEnabled(args)) {
      result.verification = verifyTaskState(task.id, {
        expected: {
          archived: true,
          calendar_event_status: eventId ? "cancelled" : undefined
        },
        priorCalendarEventId: eventId || null
      });
      result.verified = result.verification.verified;
    }

    deleted.push(result);
  }

  if (deleted.length === 1) {
    emitJson({
      ok: true,
      action: "delete-task",
      ...deleted[0]
    });
    return;
  }

  emitJson({
    ok: true,
    action: "delete-task",
    mode: "multi-match",
    query: query || null,
    count: deleted.length,
    deleted
  });
}

export function cmdSetSchedule(args) {
  const task = matchTask(args);
  if (!args.start) throw new Error('usage: set-schedule --match "..." --start <ISO|YYYY-MM-DD> [--end <ISO|YYYY-MM-DD>]');
  const schedule = resolveScheduleRange("set-schedule", args.start, args.end, { requireBoth: true });
  const existingRefs = args["calendar-event-id"] !== undefined
    ? [{ event_id: args["calendar-event-id"], start: schedule.start, end: schedule.end }]
    : calendarRefsOf(task);
  const reusableRef = existingRefs.length === 1 ? existingRefs[0] : null;
  if (!reusableRef && existingRefs.length > 1) deleteCalendarRefs(task);
  const event = reusableRef
    ? updateCalendarEvent(reusableRef.event_id, task.title, schedule.start, schedule.end)
    : createCalendarEvent(task.title, schedule.start, schedule.end);
  const stored = eventStorageForRefs([{ event_id: event.id, start: schedule.start, end: schedule.end }]);
  updatePageProperties(task.id, {
    [TASK_FIELDS.scheduledStart]: dateProperty(stored.first?.start || schedule.start),
    [TASK_FIELDS.scheduledEnd]: dateProperty(stored.first?.end || schedule.end),
    [TASK_FIELDS.needsCalendar]: checkboxProperty(true),
    [TASK_FIELDS.schedulingMode]:
      args["scheduling-mode"] !== undefined
        ? selectProperty(args["scheduling-mode"])
        : task.properties[TASK_FIELDS.schedulingMode]
          ? undefined
          : selectProperty("flexible_block"),
    [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || task.properties[TASK_FIELDS.scheduleType] || "soft"),
    [TASK_FIELDS.status]: selectProperty("scheduled"),
    [TASK_FIELDS.stage]: selectProperty(args.stage || task.properties[TASK_FIELDS.stage] || "planned"),
    [TASK_FIELDS.calendarEventId]: encodeCalendarRefs(stored.refs)
  });
  const result = {
    ok: true,
    action: "set-schedule",
    mode: reusableRef ? "updated-existing-event" : "created-new-event",
    page_id: task.id,
    task: task.title,
    start: schedule.start,
    end: schedule.end,
    calendar_event_id: event.id
  };

  if (verifyFlagEnabled(args)) {
    result.verification = verifyTaskState(task.id, {
      expected: {
        archived: false,
        scheduled: true,
        linked: true,
        schedule_synced: true,
        calendar_event_id: event.id
      }
    });
    result.verified = result.verification.verified;
  }

  emitJson(result);
}

export function cmdSetSeriesSchedule(args) {
  const task = matchTask(args);
  const spec = seriesScheduleSpec(task, args);
  const existingRefs = args["calendar-event-id"] !== undefined
    ? [{ event_id: args["calendar-event-id"], start: spec.start, end: spec.end }]
    : calendarRefsOf(task);
  const reusableRef = existingRefs.length === 1 ? existingRefs[0] : null;
  if (!reusableRef && existingRefs.length > 1) deleteCalendarRefs(task);
  const event = reusableRef
    ? updateCalendarEvent(reusableRef.event_id, task.title, spec.start, spec.end, undefined, { rrules: [spec.rrule] })
    : createCalendarEvent(task.title, spec.start, spec.end, undefined, { rrules: [spec.rrule] });
  const stored = eventStorageForRefs([{ event_id: event.id, start: spec.start, end: spec.end }]);

  updatePageProperties(task.id, {
    [TASK_FIELDS.scheduledStart]: dateProperty(stored.first?.start || spec.start),
    [TASK_FIELDS.scheduledEnd]: dateProperty(stored.first?.end || spec.end),
    [TASK_FIELDS.needsCalendar]: checkboxProperty(true),
    [TASK_FIELDS.schedulingMode]:
      args["scheduling-mode"] !== undefined
        ? selectProperty(args["scheduling-mode"])
        : task.properties[TASK_FIELDS.schedulingMode]
          ? undefined
          : selectProperty("hard_time"),
    [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || task.properties[TASK_FIELDS.scheduleType] || "hard"),
    [TASK_FIELDS.status]: selectProperty("scheduled"),
    [TASK_FIELDS.stage]: selectProperty(args.stage || task.properties[TASK_FIELDS.stage] || "planned"),
    [TASK_FIELDS.calendarEventId]: encodeCalendarRefs(stored.refs)
  });

  emitJson({
    ok: true,
    action: "set-series-schedule",
    mode: reusableRef ? "updated-existing-series" : "created-new-series",
    page_id: task.id,
    task: task.title,
    from_date: spec.fromDate,
    to_date: spec.toDate,
    weekdays: spec.weekday_names,
    start: spec.start,
    end: spec.end,
    rrule: spec.rrule,
    calendar_event_id: event.id
  });
}

export function cmdSetMultiSchedule(args) {
  const task = matchTask(args);
  const slots = multiScheduleSpec(args);
  deleteCalendarRefs(task);
  const refs = slots.map((slot) => {
    const event = createCalendarEvent(task.title, slot.start, slot.end);
    return {
      event_id: event.id,
      start: slot.start,
      end: slot.end
    };
  });
  const stored = eventStorageForRefs(refs);

  updatePageProperties(task.id, {
    [TASK_FIELDS.scheduledStart]: dateProperty(stored.first?.start || null),
    [TASK_FIELDS.scheduledEnd]: dateProperty(stored.first?.end || null),
    [TASK_FIELDS.needsCalendar]: checkboxProperty(true),
    [TASK_FIELDS.schedulingMode]:
      args["scheduling-mode"] !== undefined
        ? selectProperty(args["scheduling-mode"])
        : task.properties[TASK_FIELDS.schedulingMode]
          ? undefined
          : selectProperty("hard_time"),
    [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || task.properties[TASK_FIELDS.scheduleType] || "hard"),
    [TASK_FIELDS.status]: selectProperty("scheduled"),
    [TASK_FIELDS.stage]: selectProperty(args.stage || task.properties[TASK_FIELDS.stage] || "planned"),
    [TASK_FIELDS.calendarEventId]: encodeCalendarRefs(stored.refs)
  });

  emitJson({
    ok: true,
    action: "set-multi-schedule",
    page_id: task.id,
    task: task.title,
    slot_count: stored.refs.length,
    slots: stored.refs,
    calendar_event_id: stored.first?.event_id || null,
    calendar_event_ids: stored.refs.map((ref) => ref.event_id)
  });
}

export function cmdRemoveSchedule(args) {
  const query = args.match || args.title || args._.join(" ");
  const shouldAllowMany =
    args["all-matches"] === true ||
    (!args["page-id"] && query && /[*?]/.test(String(query)));
  const tasks = shouldAllowMany ? matchTasks(args) : [matchTask(args)];
  const removed = [];
  const skipped = [];

  for (const task of tasks) {
    const refs = calendarRefsOf(task);
    const hadSchedule =
      Boolean(task.properties[TASK_FIELDS.scheduledStart]) ||
      Boolean(task.properties[TASK_FIELDS.scheduledEnd]) ||
      refs.length > 0;
    if (!hadSchedule && tasks.length > 1) {
      skipped.push({
        page_id: task.id,
        task: task.title,
        reason: "no-schedule"
      });
      continue;
    }

    const clearedTask = {
      ...task,
      properties: {
        ...task.properties,
        [TASK_FIELDS.scheduledStart]: null,
        [TASK_FIELDS.scheduledEnd]: null,
        [TASK_FIELDS.calendarEventId]: ""
      }
    };

    deleteCalendarRefs(task);

    updatePageProperties(task.id, {
      ...clearCalendarProperties(),
      [TASK_FIELDS.status]: selectProperty(args.status || "todo"),
      [TASK_FIELDS.stage]: selectProperty(args.stage || defaultStageForTask(clearedTask))
    });

    removed.push({
      page_id: task.id,
      task: task.title,
      removed_calendar_event: refs.length > 0,
      calendar_event_id: refs[0]?.event_id || null,
      calendar_event_ids: refs.map((ref) => ref.event_id),
      had_schedule: hadSchedule
    });
  }

  if (removed.length === 1 && skipped.length === 0) {
    const result = {
      ok: true,
      action: "remove-schedule",
      ...removed[0]
    };
    if (verifyFlagEnabled(args)) {
      result.verification = verifyTaskState(removed[0].page_id, {
        expected: {
          archived: false,
          scheduled: false,
          linked: false,
          calendar_event_status: removed[0].calendar_event_id ? "cancelled" : undefined
        },
        priorCalendarEventId: removed[0].calendar_event_id || null
      });
      result.verified = result.verification.verified;
    }
    emitJson(result);
    return;
  }

  emitJson({
    ok: true,
    action: "remove-schedule",
    mode: "multi-match",
    query: query || null,
    count: tasks.length,
    removed,
    skipped
  });
}

export function cmdRescheduleTask(args) {
  const task = matchTask(args);
  if (!args.start) throw new Error('usage: reschedule-task --match "..." --start <ISO|YYYY-MM-DD> [--end <ISO|YYYY-MM-DD>]');
  const schedule = resolveScheduleRange("reschedule-task", args.start, args.end, { requireBoth: true });

  const existingRefs = calendarRefsOf(task);
  const reusableRef = existingRefs.length === 1 ? existingRefs[0] : null;
  if (!reusableRef && existingRefs.length > 1) deleteCalendarRefs(task);
  const event = reusableRef
    ? updateCalendarEvent(reusableRef.event_id, task.title, schedule.start, schedule.end)
    : createCalendarEvent(task.title, schedule.start, schedule.end);
  const stored = eventStorageForRefs([{ event_id: event.id, start: schedule.start, end: schedule.end }]);

  updatePageProperties(task.id, {
    [TASK_FIELDS.scheduledStart]: dateProperty(stored.first?.start || schedule.start),
    [TASK_FIELDS.scheduledEnd]: dateProperty(stored.first?.end || schedule.end),
    [TASK_FIELDS.needsCalendar]: checkboxProperty(true),
    [TASK_FIELDS.schedulingMode]:
      args["scheduling-mode"] !== undefined
        ? selectProperty(args["scheduling-mode"])
        : task.properties[TASK_FIELDS.schedulingMode]
          ? undefined
          : selectProperty("flexible_block"),
    [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || task.properties[TASK_FIELDS.scheduleType] || "soft"),
    [TASK_FIELDS.status]: selectProperty("scheduled"),
    [TASK_FIELDS.stage]: selectProperty(args.stage || defaultStageForTask({
      ...task,
      properties: {
        ...task.properties,
        [TASK_FIELDS.scheduledStart]: schedule.start,
        [TASK_FIELDS.scheduledEnd]: schedule.end
      }
    })),
    [TASK_FIELDS.calendarEventId]: encodeCalendarRefs(stored.refs)
  });

  console.log(JSON.stringify({
    ok: true,
    action: "reschedule-task",
    mode: reusableRef ? "updated-existing-event" : "created-new-event",
    page_id: task.id,
    task: task.title,
    start: schedule.start,
    end: schedule.end,
    calendar_event_id: event.id
  }, null, 2));
}

export function cmdLinkSchedule(args) {
  const task = matchTask(args);
  if (!args["event-id"]) throw new Error('usage: link-schedule --match "..." | --page-id <PAGE_ID> --event-id <EVENT_ID> --start <ISO|YYYY-MM-DD> [--end <ISO|YYYY-MM-DD>]');
  if (!args.start) throw new Error('usage: link-schedule --match "..." | --page-id <PAGE_ID> --event-id <EVENT_ID> --start <ISO|YYYY-MM-DD> [--end <ISO|YYYY-MM-DD>]');
  const schedule = resolveScheduleRange("link-schedule", args.start, args.end, { requireBoth: true });

  updatePageProperties(task.id, {
    [TASK_FIELDS.scheduledStart]: dateProperty(schedule.start),
    [TASK_FIELDS.scheduledEnd]: dateProperty(schedule.end),
    [TASK_FIELDS.calendarEventId]: encodeCalendarRefs([{
      event_id: args["event-id"],
      start: schedule.start,
      end: schedule.end
    }]),
    [TASK_FIELDS.needsCalendar]: checkboxProperty(true),
    [TASK_FIELDS.schedulingMode]:
      args["scheduling-mode"] !== undefined
        ? selectProperty(args["scheduling-mode"])
        : task.properties[TASK_FIELDS.schedulingMode]
          ? undefined
          : selectProperty("flexible_block"),
    [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || task.properties[TASK_FIELDS.scheduleType] || "soft"),
    [TASK_FIELDS.status]: selectProperty("scheduled"),
    [TASK_FIELDS.stage]: selectProperty(args.stage || defaultStageForTask({
      ...task,
      properties: {
        ...task.properties,
        [TASK_FIELDS.scheduledStart]: schedule.start,
        [TASK_FIELDS.scheduledEnd]: schedule.end,
        [TASK_FIELDS.needsCalendar]: true
      }
    }))
  });

  console.log(JSON.stringify({
    ok: true,
    action: "link-schedule",
    page_id: task.id,
    task: task.title,
    start: schedule.start,
    end: schedule.end,
    calendar_event_id: args["event-id"]
  }, null, 2));
}

export function cmdUnlinkSchedule(args) {
  const task = matchTask(args);
  const refs = calendarRefsOf(task);
  updatePageProperties(task.id, {
    [TASK_FIELDS.calendarEventId]: richTextProperty("")
  });

  console.log(JSON.stringify({
    ok: true,
    action: "unlink-schedule",
    page_id: task.id,
    task: task.title,
    removed_link: refs.length > 0,
    previous_calendar_event_id: refs[0]?.event_id || null,
    previous_calendar_event_ids: refs.map((ref) => ref.event_id)
  }, null, 2));
}

export function cmdVerifySchedule(args) {
  const task = matchTask(args);
  const taskStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  const taskEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
  const refs = calendarRefsOf(task);
  const checks = refs.map((ref) => {
    const lookup = fetchCalendarEvent(ref.event_id);
    const event = lookup.ok ? (lookup.event || null) : null;
    const calendarStart = event?.start?.dateTime || event?.start?.date || null;
    const calendarEnd = event?.end?.dateTime || event?.end?.date || null;
    return {
      event_id: ref.event_id,
      task_start: ref.start || taskStart,
      task_end: ref.end || taskEnd,
      calendar_start: calendarStart,
      calendar_end: calendarEnd,
      calendar_status: event?.status || null,
      lookup_ok: lookup.ok === true,
      not_found: Boolean(lookup.notFound),
      synced:
        Boolean(event) &&
        event.status !== "cancelled" &&
        normalizedInstant(ref.start || taskStart) === normalizedInstant(calendarStart) &&
        normalizedInstant(ref.end || taskEnd) === normalizedInstant(calendarEnd)
    };
  });
  const first = checks[0] || null;
  const synced = refs.length > 0 && checks.every((check) => check.synced);

  emitJson({
    ok: true,
    action: "verify-schedule",
    page_id: task.id,
    task: task.title,
    synced,
    calendar_event_id: first?.event_id || null,
    calendar_event_ids: refs.map((ref) => ref.event_id),
    task_schedule: {
      start: taskStart,
      end: taskEnd
    },
    calendar_schedule: {
      start: first?.calendar_start || null,
      end: first?.calendar_end || null
    },
    calendar_status: first?.calendar_status || null,
    lookup_ok: first ? first.lookup_ok : null,
    not_found: first ? first.not_found : false,
    checks
  });
}

export function cmdSync(args = {}) {
  const full = args.full === true;
  const waitMs = args["wait-ms"] === undefined ? undefined : Number(args["wait-ms"]);
  const result = runMirrorSync({ full, waitMs });
  console.log(JSON.stringify({ ok: true, action: "sync", ...result }, null, 2));
}

export function cmdListProjects() {
  const rows = listRows("projects", [
    { output: "status", property: "Status" },
    { output: "priority", property: "Priority" },
    { output: "area", property: "Area" }
  ]);
  console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
}

export function cmdListGoals() {
  const rows = listRows("goals", [
    { output: "status", property: "Status" },
    { output: "health", property: "Health" },
    { output: "horizon", property: "Horizon" }
  ]);
  console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
}
