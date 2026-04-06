import { TASK_FIELDS } from "./config.mjs";
import { createCalendarEvent, deleteCalendarEvent, fetchCalendarEvent, fetchCalendarEventsInRange } from "./calendar.mjs";
import { dateStart, logCompletion, readCompletions } from "./history.mjs";
import { archivePage, getPage, updatePageProperties } from "./notion.mjs";
import { loadSchedulingPreferenceMap, sortDatesByPreference, windowsForDate } from "./openviking.mjs";
import { compactTaskLabel, includeInHumanSummary } from "./human-summary.mjs";
import {
  calendarRefsOf,
  carryForwardProperties,
  clearCalendarProperties,
  defaultStageForTask,
  defaultHorizonForCadence,
  hasCalendarFields,
  inferHorizon,
  inferNeedsCalendar,
  isAutoCompleteWhenScheduledTask,
  isActiveTask,
  isDoneTask,
  mirrorRows,
  plusCadence,
  repeatModeOf,
  scheduledTouchesDate,
  selectRow,
  priorityWeight,
  summary,
  triageProperties
} from "./tasks.mjs";
import { addDays, dateProperty, diffDays, normalizeDateArg, numberProperty, richTextProperty, selectProperty } from "./util.mjs";

function normalizedInstant(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

function deleteCalendarRefs(task) {
  return deleteCalendarRefList(calendarRefSnapshot(task));
}

function calendarRefSnapshot(task) {
  return calendarRefsOf(task).map((ref) => ({
    event_id: ref.event_id,
    start: ref.start || null,
    end: ref.end || null
  }));
}

function deleteCalendarRefList(refs) {
  for (const ref of refs) {
    if (ref.event_id) deleteCalendarEvent(ref.event_id);
  }
  return refs;
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

function localParts(iso, timeZone = "Asia/Jerusalem") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

function currentLocalDateTime(timeZone = "Asia/Jerusalem") {
  return localParts(new Date().toISOString(), timeZone);
}

function eventIntervalForDate(event, date, timeZone = "Asia/Jerusalem") {
  if (event.start?.date || event.end?.date) {
    const startDate = event.start?.date || null;
    const endDate = event.end?.date || startDate;
    if (!startDate || !endDate) return null;
    if (date >= startDate && date < endDate) return [0, 1440];
    return null;
  }

  const start = event.start?.dateTime || null;
  const end = event.end?.dateTime || null;
  if (!start || !end) return null;

  const startParts = localParts(start, timeZone);
  const endParts = localParts(end, timeZone);
  if (date < startParts.date || date > endParts.date) return null;

  const startMinutes = date === startParts.date ? startParts.minutes : 0;
  const endMinutes = date === endParts.date ? endParts.minutes : 1440;
  return [Math.max(0, startMinutes), Math.min(1440, endMinutes)];
}

function taskIntervalForDate(task, date, timeZone = "Asia/Jerusalem") {
  const start = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  const end = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
  if (!start || !end) return null;
  return eventIntervalForDate({ start: { dateTime: start }, end: { dateTime: end } }, date, timeZone);
}

function mergeIntervals(intervals) {
  const ordered = intervals
    .filter((value) => Array.isArray(value) && value[1] > value[0])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of ordered) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1]) {
      merged.push([start, end]);
    } else {
      last[1] = Math.max(last[1], end);
    }
  }
  return merged;
}

function weekdayName(date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

const WEEKDAY_TO_RRULE = {
  Sunday: "SU",
  Monday: "MO",
  Tuesday: "TU",
  Wednesday: "WE",
  Thursday: "TH",
  Friday: "FR",
  Saturday: "SA"
};

function endOfWeek(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + (6 - value.getUTCDay()));
  return value.toISOString().slice(0, 10);
}

function datesInclusive(start, end) {
  const rows = [];
  let cursor = start;
  while (cursor <= end) {
    rows.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return rows;
}

function weekdayAllowed(task, date) {
  const repeatDays = task.properties[TASK_FIELDS.repeatDays] || [];
  if (repeatDays.length === 0) return true;
  return repeatDays.includes(weekdayName(date));
}

function candidateWindowsForDate(task, date, preference = null) {
  const mode = task.properties[TASK_FIELDS.schedulingMode] || null;
  if (!weekdayAllowed(task, date)) return [];
  if (mode === "hard_time" || mode === "routine_window" || mode === "list_only") return [];

  const preferredWindows = windowsForDate(preference, date);
  if (preferredWindows.length > 0) return preferredWindows;

  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day === 5) return [[10 * 60, 13 * 60], [16 * 60, 19 * 60]];
  if (day === 6) return [[10 * 60, 13 * 60], [19 * 60, 22 * 60]];
  return [[9 * 60, 12 * 60], [13 * 60, 18 * 60], [19 * 60, 21 * 60]];
}

function taskDuration(task) {
  const explicit = Number(task.properties[TASK_FIELDS.estimatedMinutes] || 0);
  if (explicit > 0) return explicit;
  const mode = task.properties[TASK_FIELDS.schedulingMode] || null;
  if (mode === "hard_time") return 60;
  if (mode === "routine_window") return 45;
  return 60;
}

function findOpenSlot(occupiedIntervals, windows, durationMinutes) {
  const busy = mergeIntervals(occupiedIntervals);
  for (const [windowStart, windowEnd] of windows) {
    let cursor = windowStart;
    for (const [busyStart, busyEnd] of busy) {
      if (busyEnd <= cursor) continue;
      if (busyStart >= windowEnd) break;
      if (busyStart - cursor >= durationMinutes) {
        return [cursor, cursor + durationMinutes];
      }
      cursor = Math.max(cursor, busyEnd);
      if (cursor >= windowEnd) break;
    }
    if (windowEnd - cursor >= durationMinutes) {
      return [cursor, cursor + durationMinutes];
    }
  }
  return null;
}

function scoreTaskForPlan(task, date) {
  const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
  const horizon = task.properties[TASK_FIELDS.horizon];
  const stage = task.properties[TASK_FIELDS.stage];
  let score = priorityWeight(task.properties[TASK_FIELDS.priority]) * 100;

  if (horizon === "today") score += 200;
  else if (horizon === "this week") score += 120;
  else if (horizon === "this month") score += 40;

  if (stage === "active") score += 35;
  if (stage === "planned") score += 15;

  if (dueDate) {
    if (dueDate <= date) score += 80;
    else {
      const days = diffDays(`${dueDate}T00:00:00Z`, `${date}T00:00:00Z`);
      if (days !== null) score += Math.max(0, 25 - Math.min(days, 25));
    }
  }

  if (inferNeedsCalendar(task)) score += 10;
  if (repeatModeOf(task) === "goal_derived") score += 8;
  if (task.properties[TASK_FIELDS.project]?.length) score += 4;
  if (task.properties[TASK_FIELDS.goal]?.length) score += 4;

  return score;
}

function comparePlannedTasks(a, b, date) {
  const scoreDiff = scoreTaskForPlan(b, date) - scoreTaskForPlan(a, date);
  if (scoreDiff !== 0) return scoreDiff;

  const aDue = dateStart(a.properties[TASK_FIELDS.dueDate]) || "9999-12-31";
  const bDue = dateStart(b.properties[TASK_FIELDS.dueDate]) || "9999-12-31";
  if (aDue !== bDue) return aDue.localeCompare(bDue);

  return (a.title || "").localeCompare(b.title || "");
}

function taskMinutes(task) {
  return Number(task.properties[TASK_FIELDS.estimatedMinutes] || 0);
}

function plannedBlock(baseDate, startMinutes, durationMinutes, task) {
  const hour = String(Math.floor(startMinutes / 60)).padStart(2, "0");
  const minute = String(startMinutes % 60).padStart(2, "0");
  const endTotal = startMinutes + durationMinutes;
  const endHour = String(Math.floor(endTotal / 60)).padStart(2, "0");
  const endMinute = String(endTotal % 60).padStart(2, "0");

  return {
    page_id: task.id,
    title: task.title,
    suggested_start: `${baseDate}T${hour}:${minute}:00`,
    suggested_end: `${baseDate}T${endHour}:${endMinute}:00`,
    estimated_minutes: durationMinutes
  };
}

function buildDayScheduleSuggestions(tasks, date, startHour = 9, endHour = 18) {
  const results = [];
  let cursor = startHour * 60;
  const limit = endHour * 60;

  for (const task of tasks) {
    const minutes = Math.max(15, taskMinutes(task) || 30);
    if (cursor + minutes > limit) break;
    results.push(plannedBlock(date, cursor, minutes, task));
    cursor += minutes + 15;
  }

  return results;
}

function taskReviewShape(task) {
  return {
    ...summary(task),
    priority: task.properties[TASK_FIELDS.priority] || null,
    estimated_minutes: taskMinutes(task),
    project_ids: task.properties[TASK_FIELDS.project] || [],
    goal_ids: task.properties[TASK_FIELDS.goal] || []
  };
}

function shortWeekday(date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function hhmm(totalMinutes) {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatIsoRange(startIso, endIso, baseDate = null) {
  if (!startIso || !endIso) return null;
  const start = localParts(startIso);
  const end = localParts(endIso);
  const range = `${hhmm(start.minutes)}-${hhmm(end.minutes)}`;
  return start.date === baseDate || baseDate === null
    ? range
    : `${shortWeekday(start.date)} ${range}`;
}

function compareDayEntries(a, b, date) {
  const aDue = dateStart(a.properties?.[TASK_FIELDS.dueDate]) || a.due_date || "9999-12-31";
  const bDue = dateStart(b.properties?.[TASK_FIELDS.dueDate]) || b.due_date || "9999-12-31";
  if (aDue !== bDue) return aDue.localeCompare(bDue);

  const aPriority = priorityWeight(a.properties?.[TASK_FIELDS.priority] || a.priority || null);
  const bPriority = priorityWeight(b.properties?.[TASK_FIELDS.priority] || b.priority || null);
  if (aPriority !== bPriority) return bPriority - aPriority;

  const aHorizon = a.properties?.[TASK_FIELDS.horizon] || a.horizon || "";
  const bHorizon = b.properties?.[TASK_FIELDS.horizon] || b.horizon || "";
  if (aHorizon !== bHorizon) {
    const order = new Map([["today", 0], ["this week", 1], ["this month", 2], ["this year", 3], ["", 4]]);
    return (order.get(aHorizon) ?? 9) - (order.get(bHorizon) ?? 9);
  }

  return String(a.title || "").localeCompare(String(b.title || ""));
}

function inSchedulingDecisionWindow(task, date, windowEnd, days) {
  const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
  const horizon = task.properties[TASK_FIELDS.horizon];

  if (dueDate && dueDate >= date && dueDate <= windowEnd) return true;
  if (horizon === "today") return true;
  if (horizon === "this week" && days >= 3) return true;
  if (horizon === "this month" && days >= 14) return true;
  if (horizon === "this year" && days >= 60) return true;
  return false;
}

function schedulingDecisionShape(task, date, reason) {
  const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
  return {
    ...taskReviewShape(task),
    due_in_days: dueDate ? diffDays(`${dueDate}T00:00:00Z`, `${date}T00:00:00Z`) : null,
    reason
  };
}

function weeklyRepeatPressure(task, date) {
  if (repeatModeOf(task) !== "manual_repeat") return null;
  if (task.properties[TASK_FIELDS.repeatWindow] !== "week") return null;
  if (!inferNeedsCalendar(task)) return null;
  if ((task.properties[TASK_FIELDS.schedulingMode] || null) === "list_only") return null;

  const target = Number(task.properties[TASK_FIELDS.repeatTargetCount] || 0);
  const progress = Number(task.properties[TASK_FIELDS.repeatProgress] || 0);
  const remainingNeeded = Math.max(0, target - progress);
  if (target <= 0 || remainingNeeded <= 0) return null;

  const weekEnd = endOfWeek(date);
  const validDates = datesInclusive(date, weekEnd).filter((day) => weekdayAllowed(task, day));
  const scheduledDates = scheduledOccurrenceDates(task, validDates);
  const missingNeeded = Math.max(0, remainingNeeded - scheduledDates.length);
  if (missingNeeded <= 0) return null;

  const unscheduledValidDates = validDates.filter((day) => !scheduledDates.includes(day));
  const remainingValidDays = unscheduledValidDates.length;
  if (remainingValidDays <= 0) return null;

  const urgency = missingNeeded >= remainingValidDays ? "mandatory_now" : "optional_this_week";
  const explanation =
    urgency === "mandatory_now"
      ? `needs ${missingNeeded} more this week and only ${remainingValidDays} valid day${remainingValidDays === 1 ? "" : "s"} remain`
      : `needs ${missingNeeded} more this week and still has ${remainingValidDays} valid day${remainingValidDays === 1 ? "" : "s"} left`;

  return {
    ...taskReviewShape(task),
    remaining_needed: remainingNeeded,
    missing_needed: missingNeeded,
    scheduled_count: scheduledDates.length,
    scheduled_dates: scheduledDates,
    remaining_valid_days: remainingValidDays,
    valid_dates: unscheduledValidDates,
    urgency,
    explanation
  };
}

function weeklyOptionShape(task, date) {
  const repeatPressure = weeklyRepeatPressure(task, date);
  if (repeatPressure) return repeatPressure;
  return {
    ...taskReviewShape(task),
    due_in_days: null
  };
}

function parseRRule(line) {
  if (!line || !/^RRULE:/i.test(line)) return null;
  const payload = line.replace(/^RRULE:/i, "");
  const entries = Object.fromEntries(
    payload
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, value = ""] = part.split("=");
        return [String(key || "").toUpperCase(), value];
      })
  );
  return entries;
}

function rruleUntilDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function recurringDatesForEvent(event, validDates) {
  const rule = Array.isArray(event?.recurrence)
    ? event.recurrence.map(parseRRule).find(Boolean)
    : null;
  if (!rule) return [];
  if (String(rule.FREQ || "").toUpperCase() !== "WEEKLY") return [];

  const byDay = String(rule.BYDAY || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const untilDate = rruleUntilDate(rule.UNTIL);
  const startDate =
    event?.start?.date ||
    (event?.start?.dateTime ? localParts(event.start.dateTime).date : null);
  if (!startDate) return [];

  return validDates.filter((day) => {
    if (day < startDate) return false;
    if (untilDate && day > untilDate) return false;
    if (byDay.length === 0) return true;
    return byDay.includes(WEEKDAY_TO_RRULE[weekdayName(day)] || "");
  });
}

function scheduledOccurrenceDates(task, validDates) {
  const valid = new Set(validDates);
  const dates = new Set();
  const refs = calendarRefsOf(task);
  const scheduledStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  if (scheduledStart && refs.length === 0) {
    const day = scheduledStart.slice(0, 10);
    if (valid.has(day)) dates.add(day);
  }

  for (const ref of refs) {
    if (!ref.event_id) continue;
    const lookup = fetchCalendarEvent(ref.event_id);
    if (!lookup.ok || !lookup.event) continue;

    const recurringDates = recurringDatesForEvent(lookup.event, validDates);
    for (const day of recurringDates) dates.add(day);

    if (recurringDates.length > 0) continue;
    const eventStart = lookup.event.start?.date || lookup.event.start?.dateTime;
    if (!eventStart) continue;
    const day = eventStart.includes("T") ? localParts(eventStart).date : eventStart;
    if (valid.has(day)) dates.add(day);
  }

  return Array.from(dates).sort();
}

function assertCalendarLookup(calendarLookup, date, context) {
  if (calendarLookup.ok) return;
  const detail = calendarLookup.stderr || calendarLookup.stdout || "calendar lookup failed";
  throw new Error(`${context} failed for ${date}: ${detail}`);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function resolveRows(rows, args, label) {
  if (args["page-id"]) {
    return [getPage(args["page-id"])];
  }
  if (args.match) return [selectRow(rows, args.match, label)];
  return rows;
}

function resolveTaskRows(args) {
  return resolveRows(mirrorRows("tasks"), args, "task");
}

function parseClockMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function hardTimeWindowFromTask(task) {
  const notes = task.properties[TASK_FIELDS.reviewNotes] || "";
  const match = String(notes).match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  const startMinutes = parseClockMinutes(match[1]);
  const endMinutes = parseClockMinutes(match[2]);
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return null;
  return { startMinutes, endMinutes, source: "review-notes-time-range" };
}

function hardTimeProposal(task, dateWindow, fallbackDate) {
  const window = hardTimeWindowFromTask(task);
  if (!window) return null;
  const allowedDates = dateWindow.filter((day) => weekdayAllowed(task, day));
  if (allowedDates.length === 0) return null;
  const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
  const targetDate =
    dueDate && allowedDates.includes(dueDate)
      ? dueDate
      : task.properties[TASK_FIELDS.horizon] === "today" && fallbackDate && allowedDates.includes(fallbackDate)
        ? fallbackDate
        : allowedDates[0] || null;
  if (!targetDate || !allowedDates.includes(targetDate)) return null;
  return {
    page_id: task.id,
    title: task.title,
    date: targetDate,
    start: isoLocal(targetDate, window.startMinutes),
    end: isoLocal(targetDate, window.endMinutes),
    duration_minutes: window.endMinutes - window.startMinutes,
    scheduling_mode: "hard_time",
    source: window.source
  };
}

function autoCompleteScheduledTask(task, date) {
  if (!isAutoCompleteWhenScheduledTask(task)) return null;
  if (!scheduledTouchesDate(task, date)) return null;
  if (isDoneTask(task)) return null;
  if (task.properties[TASK_FIELDS.stage] === "blocked") return null;

  const cadence = task.properties[TASK_FIELDS.cadence];
  const repeatMode = repeatModeOf(task);
  const repeatTargetCount = Number(task.properties[TASK_FIELDS.repeatTargetCount] || 0);
  const repeatProgress = Number(task.properties[TASK_FIELDS.repeatProgress] || 0);

  if (repeatMode === "cadence" && cadence && cadence !== "none") {
    const refs = calendarRefSnapshot(task);
    const next = plusCadence(date, cadence);
    logCompletion(task, {
      completed_at: date,
      mode: "close-day-auto-recurring-roll-forward",
      next_due: next,
      source: "close-day"
    });
    updatePageProperties(task.id, {
      [TASK_FIELDS.lastCompletedAt]: dateProperty(date),
      [TASK_FIELDS.nextDueAt]: dateProperty(next),
      [TASK_FIELDS.dueDate]: dateProperty(next),
      [TASK_FIELDS.horizon]: selectProperty(defaultHorizonForCadence(cadence) || task.properties[TASK_FIELDS.horizon] || "this week"),
      [TASK_FIELDS.status]: selectProperty("todo"),
      [TASK_FIELDS.stage]: selectProperty("active"),
      ...clearCalendarProperties()
    });
    deleteCalendarRefList(refs);
    return {
      page_id: task.id,
      title: task.title,
      mode: "recurring-roll-forward",
      next_due: next
    };
  }

  if (repeatMode === "manual_repeat") {
    const refs = calendarRefSnapshot(task);
    if (repeatTargetCount > 0) {
      const nextProgress = Math.min(repeatTargetCount, repeatProgress + 1);
      const reachedTarget = nextProgress >= repeatTargetCount;
      logCompletion(task, {
        completed_at: date,
        mode: reachedTarget ? "close-day-auto-manual-repeat-window-complete" : "close-day-auto-manual-repeat-progress",
        source: "close-day",
        progress: nextProgress,
        target: repeatTargetCount
      });
      updatePageProperties(task.id, {
        [TASK_FIELDS.repeatProgress]: numberProperty(nextProgress),
        [TASK_FIELDS.lastCompletedAt]: dateProperty(date),
        [TASK_FIELDS.status]: selectProperty(reachedTarget ? "done" : "todo"),
        [TASK_FIELDS.stage]: selectProperty(reachedTarget ? "done" : task.properties[TASK_FIELDS.stage] || "active"),
        ...clearCalendarProperties()
      });
      deleteCalendarRefList(refs);
      return {
        page_id: task.id,
        title: task.title,
        mode: reachedTarget ? "manual-repeat-window-complete" : "manual-repeat-progress",
        progress: nextProgress,
        target: repeatTargetCount
      };
    }

    logCompletion(task, {
      completed_at: date,
      mode: "close-day-auto-manual-repeat-done",
      source: "close-day"
    });
    updatePageProperties(task.id, {
      [TASK_FIELDS.status]: selectProperty("done"),
      [TASK_FIELDS.stage]: selectProperty("done"),
      [TASK_FIELDS.lastCompletedAt]: dateProperty(date),
      [TASK_FIELDS.nextDueAt]: dateProperty(null),
      ...clearCalendarProperties()
    });
    deleteCalendarRefList(refs);
    return {
      page_id: task.id,
      title: task.title,
      mode: "manual-repeat-done"
    };
  }

  logCompletion(task, {
    completed_at: date,
    mode: "close-day-auto-archive-done",
    source: "close-day"
  });
  const refs = calendarRefSnapshot(task);
  updatePageProperties(task.id, {
    ...clearCalendarProperties()
  });
  archivePage(task.id);
  deleteCalendarRefList(refs);
  return {
    page_id: task.id,
    title: task.title,
    mode: "archived"
  };
}

export function cmdShowCompleted(args) {
  const date = normalizeDateArg(args.date);
  const rows = readCompletions(date);
  console.log(JSON.stringify({ date, count: rows.length, rows }, null, 2));
}

function localClock(minutes) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function weekdayShort(date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`)
  );
}

function formatSlotLine(start, end, { includeDay = true } = {}) {
  const startParts = localParts(start);
  const endParts = localParts(end);
  const range = `${localClock(startParts.minutes)}-${localClock(endParts.minutes)}`;
  return includeDay ? `${weekdayShort(startParts.date)} ${range}` : range;
}

function buildOccupiedByDate(tasks, dateWindow) {
  const occupiedByDate = new Map();
  for (const day of dateWindow) {
    const from = isoLocal(day, 0);
    const to = isoLocal(day, 23 * 60 + 59);
    const calendarLookup = fetchCalendarEventsInRange(from, to);
    assertCalendarLookup(calendarLookup, day, "calendar availability lookup");
    const intervals = [];
    for (const event of calendarLookup.events || []) {
      if (event.status === "cancelled") continue;
      const interval = eventIntervalForDate(event, day);
      if (interval) intervals.push(interval);
    }
    for (const task of tasks) {
      const interval = taskIntervalForDate(task, day);
      if (interval) intervals.push(interval);
    }
    occupiedByDate.set(day, mergeIntervals(intervals));
  }
  return occupiedByDate;
}

function addReservedInterval(occupiedByDate, day, interval) {
  const current = occupiedByDate.get(day) || [];
  current.push(interval);
  occupiedByDate.set(day, mergeIntervals(current));
}

function candidateNeedCount(candidate) {
  if (candidate.missing_needed) return Math.max(1, Number(candidate.missing_needed));
  if (candidate.remaining_needed) return Math.max(1, Number(candidate.remaining_needed));
  return 1;
}

function flexibleSlotsForTask(task, validDates, occupiedByDate, count, preference = null) {
  const slots = [];
  const durationMinutes = Math.max(15, taskDuration(task));
  for (const day of sortDatesByPreference(validDates, preference)) {
    if (slots.length >= count) break;
    const windows = candidateWindowsForDate(task, day, preference);
    if (windows.length === 0) continue;
    const occupied = occupiedByDate.get(day) || [];
    const slot = findOpenSlot(occupied, windows, durationMinutes);
    if (!slot) continue;
    addReservedInterval(occupiedByDate, day, slot);
    slots.push({
      start: isoLocal(day, slot[0]),
      end: isoLocal(day, slot[1])
    });
  }
  return slots;
}

function hardTimeSlotsForTask(task, validDates, occupiedByDate, count) {
  const window = hardTimeWindowFromTask(task);
  if (!window) return [];
  const slots = [];
  for (const day of validDates) {
    if (!weekdayAllowed(task, day)) continue;
    if (slots.length >= count) break;
    const interval = [window.startMinutes, window.endMinutes];
    const occupied = occupiedByDate.get(day) || [];
    const conflict = occupied.some(([busyStart, busyEnd]) => busyStart < interval[1] && busyEnd > interval[0]);
    if (conflict) continue;
    addReservedInterval(occupiedByDate, day, interval);
    slots.push({
      start: isoLocal(day, interval[0]),
      end: isoLocal(day, interval[1])
    });
  }
  return slots;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function candidateScore(candidate, date) {
  let score = candidate.kind === "weekly_mandatory" ? 1000 : 0;
  if (candidate.kind === "hard_time_ready") score += 700;
  if (candidate.kind === "weekly_optional") score += 500;
  if (candidate.priority === "high") score += 200;
  if (candidate.priority === "medium") score += 100;
  if (candidate.due_in_days !== null && candidate.due_in_days !== undefined) {
    score += Math.max(0, 60 - Math.min(Number(candidate.due_in_days) * 5, 60));
  }
  if (candidate.repeat_mode === "manual_repeat") score += 25;
  if (candidate.horizon === "this week") score += 15;
  if (candidate.horizon === "today") score += 30;
  if (candidate.remaining_needed) score += Math.min(Number(candidate.remaining_needed) * 10, 50);
  if ((candidate.valid_dates || []).includes(date)) score += 15;
  return score;
}

export async function cmdEveningSummary(args) {
  const date = normalizeDateArg(args.date);
  const days = Math.max(1, Number(args.days || 3));
  const taskLimit = Math.max(1, Number(args["task-limit"] || 3));
  const tasks = mirrorRows("tasks").filter((task) => task.archived !== true);
  const activeTasks = tasks.filter((task) => isActiveTask(task) && includeInHumanSummary(task));
  const completions = readCompletions(date).filter((row) => includeInHumanSummary(row));
  const completedLabels = uniqueBy(
    completions.map((row) => compactTaskLabel(row.title)),
    (label) => label.toLowerCase()
  );

  const doneToday = completedLabels;

  const openToday = activeTasks.filter((task) => task.properties[TASK_FIELDS.horizon] === "today");
  const overdue = activeTasks.filter((task) => {
    const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
    return Boolean(dueDate) && dueDate < date && !isDoneTask(task);
  });

  const needsAttention = uniqueBy(
    [...openToday, ...overdue]
      .filter((task) => !doneToday.some((label) => label.toLowerCase() === compactTaskLabel(task).toLowerCase()))
      .sort((a, b) => {
        const aScheduled = dateStart(a.properties[TASK_FIELDS.scheduledStart]) ? 0 : 1;
        const bScheduled = dateStart(b.properties[TASK_FIELDS.scheduledStart]) ? 0 : 1;
        if (aScheduled !== bScheduled) return aScheduled - bScheduled;
        const aPriority = priorityWeight(a.properties[TASK_FIELDS.priority]);
        const bPriority = priorityWeight(b.properties[TASK_FIELDS.priority]);
        if (aPriority !== bPriority) return bPriority - aPriority;
        return (a.title || "").localeCompare(b.title || "");
      }),
    (task) => task.id
  );

  const scheduling = [];
  const decisionsDate = addDays(date, 1);
  const decisionWindow = Array.from({ length: days }, (_, index) => addDays(decisionsDate, index));
  const schedulingPayload = (() => {
    const tasksForDecisions = resolveTaskRows({}).filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked");
    const decisionTasks = tasksForDecisions
      .filter((task) => inferNeedsCalendar(task) || task.properties[TASK_FIELDS.schedulingMode] === "flexible_block")
      .filter((task) => {
        const repeatPressure = weeklyRepeatPressure(task, decisionsDate);
        if (repeatPressure && repeatPressure.missing_needed > 0) return true;
        return !hasCalendarFields(task);
      })
      .filter((task) => (task.properties[TASK_FIELDS.schedulingMode] || null) !== "list_only")
      .filter((task) => inSchedulingDecisionWindow(task, decisionsDate, addDays(decisionsDate, days - 1), days))
      .sort((a, b) => comparePlannedTasks(a, b, decisionsDate));

    const hardTimeReady = [];
    const flexibleToDiscuss = [];
    const weeklyRepeatMandatory = [];
    const weeklyRepeatOptional = [];

    for (const task of decisionTasks) {
      if (!includeInHumanSummary(task)) continue;
      const repeatPressure = weeklyRepeatPressure(task, decisionsDate);
      if (repeatPressure) {
        if (repeatPressure.urgency === "mandatory_now") weeklyRepeatMandatory.push(repeatPressure);
        else weeklyRepeatOptional.push(repeatPressure);
      }

      const mode = task.properties[TASK_FIELDS.schedulingMode] || "flexible_block";
      if (mode === "hard_time") {
        const proposal = hardTimeProposal(task, decisionWindow, decisionsDate);
        if (proposal) {
          hardTimeReady.push({
            ...schedulingDecisionShape(task, decisionsDate, "hard-time-ready"),
            suggested_start: proposal.start,
            suggested_end: proposal.end,
            source: proposal.source
          });
        }
        continue;
      }
      flexibleToDiscuss.push(schedulingDecisionShape(task, decisionsDate, "flexible-needs-conversational-scheduling"));
    }

    return { hardTimeReady, flexibleToDiscuss, weeklyRepeatMandatory, weeklyRepeatOptional };
  })();

  const byId = new Map();
  for (const item of schedulingPayload.weeklyRepeatMandatory) {
    byId.set(item.id, { ...item, kind: "weekly_mandatory" });
  }
  for (const item of schedulingPayload.hardTimeReady) {
    if (!byId.has(item.id)) byId.set(item.id, { ...item, kind: "hard_time_ready" });
  }
  for (const item of schedulingPayload.weeklyRepeatOptional) {
    if (byId.has(item.id)) continue;
    byId.set(item.id, { ...item, kind: "weekly_optional" });
  }
  for (const item of schedulingPayload.flexibleToDiscuss) {
    if (!byId.has(item.id)) byId.set(item.id, { ...item, kind: "flexible" });
  }

  const scheduleCandidates = Array.from(byId.values())
    .filter((item) => includeInHumanSummary(item))
    .sort((a, b) => candidateScore(b, decisionsDate) - candidateScore(a, decisionsDate))
    .slice(0, taskLimit);
  const occupiedByDate = buildOccupiedByDate(activeTasks, datesInclusive(decisionsDate, addDays(date, days)));
  const scheduleCandidateTasks = scheduleCandidates.map((candidate) => getPage(candidate.id));
  const preferencesByTaskId = await loadSchedulingPreferenceMap(scheduleCandidateTasks, compactTaskLabel);

  for (const candidate of scheduleCandidates) {
    const task =
      scheduleCandidateTasks.find((value) => value.id === candidate.id) ||
      getPage(candidate.id);
    const preference = preferencesByTaskId.get(task.id) || null;
    const validDates =
      candidate.valid_dates && candidate.valid_dates.length > 0
        ? candidate.valid_dates
        : datesInclusive(decisionsDate, addDays(decisionsDate, days - 1));
    const neededCount =
      candidate.kind === "weekly_mandatory" || candidate.kind === "weekly_optional"
        ? Math.min(candidateNeedCount(candidate), validDates.length)
        : 1;
    const slots =
      task.properties[TASK_FIELDS.schedulingMode] === "hard_time"
        ? hardTimeSlotsForTask(task, validDates, occupiedByDate, neededCount)
        : flexibleSlotsForTask(task, validDates, occupiedByDate, neededCount, preference);
    if (slots.length === 0) continue;
    scheduling.push({
      label: compactTaskLabel(task),
      reason: candidate.kind === "weekly_mandatory" ? candidate.explanation : null,
      lines: slots.map((slot) => formatSlotLine(slot.start, slot.end))
    });
  }

  const lines = [];

  if (doneToday.length > 0) {
    lines.push("✅ **Done today:**", "");
    for (const label of doneToday) {
      lines.push(`• **${label}**`);
    }
    lines.push("");
  }

  if (needsAttention.length > 0) {
    lines.push("⚠️ **Needs attention:**", "");
    lines.push("❌/✅ Is it Done? (The tasks below were scheduled but not marked as complete):", "");
    for (const task of needsAttention) {
      lines.push(`• **${compactTaskLabel(task)}** - Done? Reschedule?`);
    }
    lines.push("");
  }

  if (scheduling.length > 0) {
    lines.push("📅 **Schedule these**", "");
    for (const item of scheduling) {
      lines.push(`• **${item.label}**`);
      if (item.reason) {
        lines.push(`Must schedule this week: ${item.reason}.`);
      }
      for (const line of item.lines) {
        lines.push(line);
      }
      lines.push("");
    }
  }

  const output = lines.join("\n").trim();
  console.log(output || "✅ **Done today:**\n\n• nothing real closed yet");
}

function nextManualRepeatDate(task, date) {
  const cadence = task.properties[TASK_FIELDS.cadence];
  if (!cadence || cadence === "none") return null;
  let next = dateStart(task.properties[TASK_FIELDS.dueDate]) || dateStart(task.properties[TASK_FIELDS.nextDueAt]) || date;
  while (next < date) {
    const advanced = plusCadence(next, cadence);
    if (!advanced || advanced === next) return null;
    next = advanced;
  }
  return next;
}

export function cmdRefreshManualRepeat(args) {
  const date = normalizeDateArg(args.date);
  const apply = args.apply === true;
  const tasks = resolveTaskRows(args);
  const candidates = tasks
    .filter((task) => {
      if (repeatModeOf(task) !== "manual_repeat") return false;
      const currentDue = dateStart(task.properties[TASK_FIELDS.dueDate]) || dateStart(task.properties[TASK_FIELDS.nextDueAt]);
      return isDoneTask(task) || (currentDue ? currentDue < date : false);
    })
    .map((task) => {
      const nextDue = nextManualRepeatDate(task, date);
      if (!nextDue) return null;
      const draft = {
        ...task,
        properties: {
          ...task.properties,
          [TASK_FIELDS.dueDate]: { start: nextDue, end: null, time_zone: null },
          [TASK_FIELDS.nextDueAt]: { start: nextDue, end: null, time_zone: null },
          [TASK_FIELDS.status]: "todo",
          [TASK_FIELDS.stage]: "active"
        }
      };
      const nextHorizon = inferHorizon(draft, date);
      const nextStage = defaultStageForTask({
        ...draft,
        properties: {
          ...draft.properties,
          [TASK_FIELDS.horizon]: nextHorizon
        }
      }, nextHorizon);
      return {
        task,
        proposal: {
          page_id: task.id,
          title: task.title,
          cadence: task.properties[TASK_FIELDS.cadence] || null,
          previous_progress: Number(task.properties[TASK_FIELDS.repeatProgress] || 0),
          repeat_target_count: Number(task.properties[TASK_FIELDS.repeatTargetCount] || 0) || null,
          next_due: nextDue,
          next_horizon: nextHorizon,
          next_stage: nextStage
        }
      };
    })
    .filter(Boolean);

  const refreshed = [];
  if (apply) {
    for (const item of candidates) {
      const refs = calendarRefSnapshot(item.task);
      updatePageProperties(item.task.id, {
        [TASK_FIELDS.dueDate]: dateProperty(item.proposal.next_due),
        [TASK_FIELDS.nextDueAt]: dateProperty(item.proposal.next_due),
        [TASK_FIELDS.repeatProgress]: numberProperty(0),
        [TASK_FIELDS.horizon]: selectProperty(item.proposal.next_horizon),
        [TASK_FIELDS.stage]: selectProperty(item.proposal.next_stage),
        [TASK_FIELDS.status]: selectProperty("todo"),
        ...clearCalendarProperties()
      });
      deleteCalendarRefList(refs);
      refreshed.push(item.proposal);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "refresh-manual-repeat",
    date,
    apply,
    count: candidates.length,
    candidates: candidates.map((item) => item.proposal),
    refreshed
  }, null, 2));
}

export function cmdCloseDay(args) {
  const date = normalizeDateArg(args.date);
  const carryTo = args["carry-to"] || null;
  const tasks = resolveTaskRows(args).filter((task) => task.archived !== true);

  const archivedOneTime = [];
  const rolledRecurring = [];
  const preservedManualRepeat = [];
  const carryCandidates = [];
  const carriedForward = [];
  const blocked = [];
  const autoCompleted = [];

  for (const task of tasks) {
    const isTodayTask = task.properties[TASK_FIELDS.horizon] === "today";
    const cadence = task.properties[TASK_FIELDS.cadence];
    const repeatMode = repeatModeOf(task);
    const autoCompletion = autoCompleteScheduledTask(task, date);

    if (autoCompletion) {
      autoCompleted.push(autoCompletion);
      if (autoCompletion.mode === "recurring-roll-forward") {
        rolledRecurring.push({
          page_id: task.id,
          title: task.title,
          next_due: autoCompletion.next_due
        });
      } else if (autoCompletion.mode === "archived") {
        archivedOneTime.push({ page_id: task.id, title: task.title });
      }
      continue;
    }

    if (!isTodayTask) continue;

    if (isDoneTask(task)) {
      if (repeatMode === "cadence" && cadence && cadence !== "none") {
        const refs = calendarRefSnapshot(task);
        const next = plusCadence(date, cadence);
        logCompletion(task, {
          completed_at: date,
          mode: "close-day-recurring-roll-forward",
          next_due: next,
          source: "close-day"
        });
        updatePageProperties(task.id, {
          [TASK_FIELDS.lastCompletedAt]: dateProperty(date),
          [TASK_FIELDS.nextDueAt]: dateProperty(next),
          [TASK_FIELDS.dueDate]: dateProperty(next),
          [TASK_FIELDS.horizon]: selectProperty(defaultHorizonForCadence(cadence) || "this week"),
          [TASK_FIELDS.status]: selectProperty("todo"),
          [TASK_FIELDS.stage]: selectProperty("active"),
          ...clearCalendarProperties()
        });
        deleteCalendarRefList(refs);
        rolledRecurring.push({ page_id: task.id, title: task.title, next_due: next });
        continue;
      }

      if (repeatMode === "manual_repeat") {
        const refs = calendarRefSnapshot(task);
        const patch = {
          ...clearCalendarProperties(),
          [TASK_FIELDS.nextDueAt]: dateProperty(null)
        };
        if (!dateStart(task.properties[TASK_FIELDS.lastCompletedAt])) {
          patch[TASK_FIELDS.lastCompletedAt] = dateProperty(date);
        }
        updatePageProperties(task.id, patch);
        deleteCalendarRefList(refs);
        preservedManualRepeat.push({ page_id: task.id, title: task.title });
        continue;
      }

      logCompletion(task, {
        completed_at: date,
        mode: "close-day-archive-done",
        source: "close-day"
      });
      const refs = calendarRefSnapshot(task);
      updatePageProperties(task.id, {
        ...clearCalendarProperties()
      });
      archivePage(task.id);
      deleteCalendarRefList(refs);
      archivedOneTime.push({ page_id: task.id, title: task.title });
      continue;
    }

    if (task.properties[TASK_FIELDS.stage] === "blocked") {
      blocked.push(summary(task));
      continue;
    }

    if (carryTo) {
      const nextMissCount = Number(task.properties[TASK_FIELDS.missCount] || 0) + 1;
      const hadCalendarState =
        Boolean(dateStart(task.properties[TASK_FIELDS.scheduledStart])) ||
        Boolean(dateStart(task.properties[TASK_FIELDS.scheduledEnd])) ||
        calendarRefsOf(task).length > 0;
      const refs = hadCalendarState ? calendarRefSnapshot(task) : [];
      updatePageProperties(task.id, carryForwardProperties(carryTo, nextMissCount));
      if (hadCalendarState) deleteCalendarRefList(refs);
      carriedForward.push({
        page_id: task.id,
        title: task.title,
        carry_to: carryTo,
        miss_count: nextMissCount,
        cleared_calendar_state: hadCalendarState
      });
      continue;
    }

    carryCandidates.push(summary(task));
  }

  console.log(JSON.stringify({
    ok: true,
    action: "close-day",
    date,
    archived_one_time: archivedOneTime,
    rolled_recurring: rolledRecurring,
    preserved_manual_repeat: preservedManualRepeat,
    auto_completed: autoCompleted,
    carry_candidates: carryCandidates,
    carried_forward: carriedForward,
    blocked
  }, null, 2));
}

export function cmdTriageInbox(args) {
  const limit = args.limit ? Number(args.limit) : null;
  const baseDate = normalizeDateArg(args.date);
  const apply = args.apply === true;
  const inbox = resolveTaskRows(args).filter(
    (task) => task.properties[TASK_FIELDS.stage] === "inbox" && task.archived !== true
  );
  const selected = limit ? inbox.slice(0, limit) : inbox;

  const proposals = selected.map((task) => {
    const suggestedHorizon = inferHorizon(task, baseDate);
    const suggestedNeedsCalendar = inferNeedsCalendar(task);
    const suggestedStage =
      suggestedNeedsCalendar && !dateStart(task.properties[TASK_FIELDS.scheduledStart]) ? "planned" : "active";
    const reasons = [];
    const repeatMode = repeatModeOf(task);
    if (dateStart(task.properties[TASK_FIELDS.dueDate])) reasons.push("due-date-driven");
    else if (repeatMode === "cadence") reasons.push("cadence-driven");
    else if (repeatMode === "manual_repeat") reasons.push("manual-repeat");
    else if (repeatMode === "goal_derived") reasons.push("goal-derived");
    else reasons.push("default-weekly-placement");
    if (suggestedNeedsCalendar) reasons.push("calendar-worthy");

    return {
      task,
      proposal: {
        page_id: task.id,
        title: task.title,
        suggested_horizon: suggestedHorizon,
        suggested_stage: suggestedStage,
        suggested_needs_calendar: suggestedNeedsCalendar,
        reasons
      }
    };
  });

  const applied = [];
  if (apply) {
    for (const item of proposals) {
      updatePageProperties(item.task.id, triageProperties(item.proposal));
      applied.push(item.proposal);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "triage-inbox",
    date: baseDate,
    applied: apply,
    count: proposals.length,
    proposals: proposals.map((item) => item.proposal),
    applied_rows: applied
  }, null, 2));
}

export function cmdReconcileCalendar(args) {
  const applyClearStale = args["apply-clear-stale"] === true;
  const applyLinkMatches = args["apply-link-matches"] === true;
  const tasks = resolveTaskRows(args);

  const missingScheduleAndEvent = [];
  const scheduledWithoutEvent = [];
  const linkableMatches = [];
  const missingExternalEvent = [];
  const cancelledExternalEvent = [];
  const scheduleDrift = [];
  const externalLookupErrors = [];
  const staleEventWithoutSchedule = [];
  const completedWithEventRef = [];
  const invertedSchedule = [];
  const cleared = [];
  const linked = [];

  for (const task of tasks) {
    const status = task.properties[TASK_FIELDS.status];
    const stage = task.properties[TASK_FIELDS.stage];
    const needsCalendar = task.properties[TASK_FIELDS.needsCalendar] === true;
    const scheduledStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
    const scheduledEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
    const refs = calendarRefsOf(task);
    const eventId = refs[0]?.event_id || "";
    const archived = task.archived === true || stage === "archived";
    const base = summary(task);

    if (needsCalendar && !scheduledStart && !scheduledEnd && !eventId && status !== "done" && !archived) {
      missingScheduleAndEvent.push(base);
    }
    if (needsCalendar && (scheduledStart || scheduledEnd) && !eventId && status !== "done" && !archived) {
      scheduledWithoutEvent.push(base);
      if (scheduledStart && scheduledEnd) {
        const rangeLookup = fetchCalendarEventsInRange(scheduledStart, scheduledEnd);
        if (!rangeLookup.ok) {
          externalLookupErrors.push({
            ...base,
            error_status: rangeLookup.status,
            error: rangeLookup.stderr || rangeLookup.stdout || "calendar range lookup failed"
          });
        } else {
          const notionStart = normalizedInstant(scheduledStart);
          const notionEnd = normalizedInstant(scheduledEnd);
          const exactMatches = (rangeLookup.events || []).filter((event) => {
            const eventStart = normalizedInstant(event.start?.dateTime || event.start?.date || null);
            const eventEnd = normalizedInstant(event.end?.dateTime || event.end?.date || null);
            return (
              event.status !== "cancelled" &&
              (event.summary || "") === task.title &&
              eventStart === notionStart &&
              eventEnd === notionEnd
            );
          });

          if (exactMatches.length === 1) {
            const event = exactMatches[0];
            const match = {
              ...base,
              calendar_event_id: event.id,
              calendar_summary: event.summary || null,
              calendar_start: event.start?.dateTime || event.start?.date || null,
              calendar_end: event.end?.dateTime || event.end?.date || null
            };
            linkableMatches.push(match);
            if (applyLinkMatches) {
              updatePageProperties(task.id, {
                [TASK_FIELDS.calendarEventId]: richTextProperty(event.id)
              });
              linked.push({
                page_id: task.id,
                title: task.title,
                calendar_event_id: event.id,
                reason: "exact-title-time-match"
              });
            }
          }
        }
      }
    }
    if (refs.length > 0 && !scheduledStart && !scheduledEnd && status !== "done" && !archived) {
      staleEventWithoutSchedule.push(base);
      if (applyClearStale) {
        deleteCalendarRefs(task);
        updatePageProperties(task.id, clearCalendarProperties());
        cleared.push({ page_id: task.id, title: task.title, reason: "event-ref-without-schedule" });
      }
    }
    if (refs.length > 0 && (status === "done" || stage === "done" || archived)) {
      completedWithEventRef.push(base);
      if (applyClearStale) {
        deleteCalendarRefs(task);
        updatePageProperties(task.id, clearCalendarProperties());
        cleared.push({ page_id: task.id, title: task.title, reason: "done-or-archived-with-event-ref" });
      }
    }
    if (refs.length > 0 && status !== "done" && !archived) {
      let shouldClearTask = false;
      for (const ref of refs) {
        if (!ref.event_id) continue;
        const lookup = fetchCalendarEvent(ref.event_id);
        if (!lookup.ok) {
          if (lookup.notFound) {
            missingExternalEvent.push({
              ...base,
              calendar_event_id: ref.event_id
            });
            shouldClearTask = true;
          } else {
            externalLookupErrors.push({
              ...base,
              calendar_event_id: ref.event_id,
              error_status: lookup.status,
              error: lookup.stderr || lookup.stdout || "calendar lookup failed"
            });
          }
          continue;
        }

        const event = lookup.event || {};
        const eventStatus = event.status || null;
        const eventStart = normalizedInstant(event.start?.dateTime || event.start?.date || null);
        const eventEnd = normalizedInstant(event.end?.dateTime || event.end?.date || null);
        const notionStart = normalizedInstant(ref.start || scheduledStart);
        const notionEnd = normalizedInstant(ref.end || scheduledEnd);

        if (eventStatus === "cancelled") {
          cancelledExternalEvent.push({
            ...base,
            calendar_event_id: ref.event_id
          });
          shouldClearTask = true;
          continue;
        }

        if (
          (notionStart && eventStart && notionStart !== eventStart) ||
          (notionEnd && eventEnd && notionEnd !== eventEnd)
        ) {
          scheduleDrift.push({
            ...base,
            calendar_event_id: ref.event_id,
            notion_start: ref.start || scheduledStart || null,
            notion_end: ref.end || scheduledEnd || null,
            calendar_start: event.start?.dateTime || event.start?.date || null,
            calendar_end: event.end?.dateTime || event.end?.date || null,
            calendar_summary: event.summary || null
          });
        }
      }
      if (applyClearStale && shouldClearTask) {
        updatePageProperties(task.id, clearCalendarProperties());
        cleared.push({ page_id: task.id, title: task.title, reason: "missing-or-cancelled-external-event" });
      }
    }
    if (scheduledStart && scheduledEnd && Date.parse(scheduledEnd) < Date.parse(scheduledStart)) {
      invertedSchedule.push(base);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "reconcile-calendar",
    mode: "notion-plus-google-calendar",
    external_calendar_check_available: true,
    apply_link_matches: applyLinkMatches,
    missing_schedule_and_event: missingScheduleAndEvent,
    scheduled_without_event: scheduledWithoutEvent,
    linkable_matches: linkableMatches,
    missing_external_event: missingExternalEvent,
    cancelled_external_event: cancelledExternalEvent,
    schedule_drift: scheduleDrift,
    external_lookup_errors: externalLookupErrors,
    stale_event_without_schedule: staleEventWithoutSchedule,
    completed_or_archived_with_event_ref: completedWithEventRef,
    inverted_schedule: invertedSchedule,
    cleared,
    linked
  }, null, 2));
}

export function cmdReviewStale(args) {
  const date = normalizeDateArg(args.date);
  const missThreshold = args["miss-threshold"] ? Number(args["miss-threshold"]) : 3;
  const blockedDays = args["blocked-days"] ? Number(args["blocked-days"]) : 7;
  const tasks = resolveTaskRows(args).filter((task) => !isDoneTask(task));
  const validProjectIds = new Set(mirrorRows("projects").map((row) => row.id));
  const validGoalIds = new Set(mirrorRows("goals").map((row) => row.id));

  const blockedStale = [];
  const overdue = [];
  const repeatedMisses = [];
  const brokenProjectLinks = [];
  const brokenGoalLinks = [];
  const calendarGaps = [];
  const longHorizonUnanchored = [];
  const invertedSchedule = [];

  for (const task of tasks) {
    const base = {
      ...summary(task),
      last_edited_time: task.last_edited_time || null,
      miss_count: Number(task.properties[TASK_FIELDS.missCount] || 0),
      project_ids: task.properties[TASK_FIELDS.project] || [],
      goal_ids: task.properties[TASK_FIELDS.goal] || []
    };
    const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
    const scheduledStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
    const scheduledEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
    const lastEditedDate = task.last_edited_time ? String(task.last_edited_time).slice(0, 10) : null;
    const lastEditedDaysAgo = lastEditedDate ? diffDays(`${date}T00:00:00Z`, `${lastEditedDate}T00:00:00Z`) : null;
    const missingProjectIds = base.project_ids.filter((id) => !validProjectIds.has(id));
    const missingGoalIds = base.goal_ids.filter((id) => !validGoalIds.has(id));

    if (task.properties[TASK_FIELDS.stage] === "blocked" && lastEditedDaysAgo !== null && lastEditedDaysAgo >= blockedDays) {
      blockedStale.push({
        ...base,
        blocked_days: lastEditedDaysAgo,
        blocked_by: task.properties[TASK_FIELDS.blockedBy] || "",
        waiting_on: task.properties[TASK_FIELDS.waitingOn] || ""
      });
    }

    if (dueDate && dueDate < date) {
      overdue.push({
        ...base,
        overdue_by_days: diffDays(`${date}T00:00:00Z`, `${dueDate}T00:00:00Z`),
        due_date: dueDate
      });
    }

    if (base.miss_count >= missThreshold) {
      repeatedMisses.push(base);
    }

    if (missingProjectIds.length > 0) {
      brokenProjectLinks.push({
        ...base,
        missing_project_ids: missingProjectIds
      });
    }

    if (missingGoalIds.length > 0) {
      brokenGoalLinks.push({
        ...base,
        missing_goal_ids: missingGoalIds
      });
    }

    if (inferNeedsCalendar(task) && !hasCalendarFields(task)) {
      calendarGaps.push(base);
    }

    if (
      (task.properties[TASK_FIELDS.horizon] === "this month" || task.properties[TASK_FIELDS.horizon] === "this year") &&
      base.project_ids.length === 0 &&
      base.goal_ids.length === 0
    ) {
      longHorizonUnanchored.push(base);
    }

    if (scheduledStart && scheduledEnd && Date.parse(scheduledEnd) < Date.parse(scheduledStart)) {
      invertedSchedule.push(base);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "review-stale",
    date,
    miss_threshold: missThreshold,
    blocked_days: blockedDays,
    counts: {
      blocked_stale: blockedStale.length,
      overdue: overdue.length,
      repeated_misses: repeatedMisses.length,
      broken_project_links: brokenProjectLinks.length,
      broken_goal_links: brokenGoalLinks.length,
      calendar_gaps: calendarGaps.length,
      long_horizon_unanchored: longHorizonUnanchored.length,
      inverted_schedule: invertedSchedule.length
    },
    blocked_stale: blockedStale,
    overdue,
    repeated_misses: repeatedMisses,
    broken_project_links: brokenProjectLinks,
    broken_goal_links: brokenGoalLinks,
    calendar_gaps: calendarGaps,
    long_horizon_unanchored: longHorizonUnanchored,
    inverted_schedule: invertedSchedule
  }, null, 2));
}

export function cmdPlanDay(args) {
  const date = normalizeDateArg(args.date);
  const limit = args.limit ? Number(args.limit) : 3;
  const startHour = args["start-hour"] ? Number(args["start-hour"]) : 9;
  const endHour = args["end-hour"] ? Number(args["end-hour"]) : 18;
  const tasks = mirrorRows("tasks").filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked");

  const today = tasks.filter((task) => task.properties[TASK_FIELDS.horizon] === "today");
  const urgentWeek = tasks.filter((task) => {
    if (task.properties[TASK_FIELDS.horizon] !== "this week") return false;
    const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
    if (!dueDate) return false;
    return dueDate <= date || diffDays(`${dueDate}T00:00:00Z`, `${date}T00:00:00Z`) <= 3;
  });

  const candidateMap = new Map();
  for (const task of [...today, ...urgentWeek]) {
    candidateMap.set(task.id, task);
  }
  const candidates = [...candidateMap.values()].sort((a, b) => comparePlannedTasks(a, b, date));

  const alreadyScheduled = candidates.filter((task) => hasCalendarFields(task));
  const priorities = candidates.slice(0, limit);
  const unscheduledPriorityTasks = priorities.filter((task) => !hasCalendarFields(task));
  const scheduleSuggestions = buildDayScheduleSuggestions(
    unscheduledPriorityTasks.filter((task) => inferNeedsCalendar(task)),
    date,
    startHour,
    endHour
  );

  console.log(JSON.stringify({
    ok: true,
    action: "plan-day",
    date,
    limit,
    counts: {
      today: today.length,
      urgent_week: urgentWeek.length,
      candidate_pool: candidates.length,
      priorities: priorities.length,
      already_scheduled: alreadyScheduled.length,
      schedule_suggestions: scheduleSuggestions.length
    },
    priorities: priorities.map(taskReviewShape),
    already_scheduled: alreadyScheduled.map(taskReviewShape),
    schedule_suggestions: scheduleSuggestions,
    notes: [
      "priorities prefer today items, urgent weekly work, and higher-priority tasks",
      "schedule suggestions are heuristic blocks only and do not inspect Google Calendar availability"
    ]
  }, null, 2));
}

export async function cmdTomorrowPlan(args) {
  const date = normalizeDateArg(args.date || "tomorrow");
  const days = Math.max(1, Number(args.days || 5));
  const limit = Math.max(1, Number(args.limit || 20));
  const windowEnd = addDays(date, days - 1);
  const tasks = resolveTaskRows(args)
    .filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked");
  const scheduledTomorrow = tasks
    .filter((task) => scheduledTouchesDate(task, date))
    .sort((a, b) => comparePlannedTasks(a, b, date));

  const unscheduledCalendarTasks = tasks
    .filter((task) => inferNeedsCalendar(task))
    .filter((task) => !hasCalendarFields(task))
    .filter((task) => (task.properties[TASK_FIELDS.schedulingMode] || null) !== "list_only")
    .filter((task) => inSchedulingDecisionWindow(task, date, windowEnd, days))
    .sort((a, b) => comparePlannedTasks(a, b, date))
    .slice(0, limit);

  const dateWindow = Array.from({ length: days }, (_, index) => addDays(date, index));
  const preferencesByTaskId = await loadSchedulingPreferenceMap(unscheduledCalendarTasks, compactTaskLabel);
  const occupiedByDate = buildOccupiedByDate(tasks, dateWindow);

  const hardTimeOrWindow = [];
  const flexibleToDiscuss = [];
  const weeklyRepeatMandatory = [];
  for (const task of unscheduledCalendarTasks) {
    const repeatPressure = weeklyRepeatPressure(task, date);
    if (repeatPressure) {
      if (repeatPressure.urgency === "mandatory_now") weeklyRepeatMandatory.push(repeatPressure);
    }

    const mode = task.properties[TASK_FIELDS.schedulingMode] || "flexible_block";
    const preference = preferencesByTaskId.get(task.id) || null;
    if (mode === "hard_time") {
      hardTimeOrWindow.push(schedulingDecisionShape(task, date, "hard-time-needs-clear-time"));
      continue;
    }
    if (mode === "routine_window") {
      hardTimeOrWindow.push(schedulingDecisionShape(task, date, "routine-window-needs-clear-window"));
      continue;
    }
    const preferenceSlots = flexibleSlotsForTask(task, dateWindow, occupiedByDate, 2, preference).map((slot) => ({
      start: slot.start,
      end: slot.end
    }));
    flexibleToDiscuss.push({
      ...schedulingDecisionShape(task, date, "flexible-needs-conversational-scheduling"),
      preferred_slots: preferenceSlots,
      preference_summary: preference?.summary || null
    });
  }

  const listOnlyTomorrow = tasks
    .filter((task) => !inferNeedsCalendar(task))
    .filter((task) => !scheduledTouchesDate(task, date))
    .filter((task) => {
      const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
      return task.properties[TASK_FIELDS.horizon] === "today" || dueDate === date;
    })
    .sort((a, b) => comparePlannedTasks(a, b, date));

  const rescheduleTomorrow = uniqueBy([
    ...flexibleToDiscuss.filter((task) => Number(task.due_in_days) <= 0),
    ...hardTimeOrWindow.filter((task) => {
      if (Number(task.due_in_days) > 0) return false;
      if (task.reason === "hard-time-needs-clear-time" && Number(task.due_in_days) < 0) return false;
      return true;
    }),
    ...weeklyRepeatMandatory,
    ...listOnlyTomorrow.map((task) => ({
      ...taskReviewShape(task),
      due_date: dateStart(task.properties[TASK_FIELDS.dueDate]),
      due_in_days: dateStart(task.properties[TASK_FIELDS.dueDate]) === date ? 0 : null,
      reason: "list-only-tomorrow"
    }))
  ], (row) => row.id).sort((a, b) => compareDayEntries(a, b, date));

  const rescheduleIds = new Set(rescheduleTomorrow.map((row) => row.id));
  const scheduledTomorrowIds = new Set(scheduledTomorrow.map((task) => task.id));

  const weeklyOptionTasks = tasks
    .filter((task) => task.properties[TASK_FIELDS.horizon] === "this week")
    .filter((task) => !rescheduleIds.has(task.id))
    .filter((task) => !scheduledTomorrowIds.has(task.id))
    .filter((task) => {
      const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
      if (dueDate && dueDate <= date) return false;
      const repeatPressure = weeklyRepeatPressure(task, date);
      if (repeatPressure?.urgency === "mandatory_now") return false;
      if (repeatPressure?.urgency === "optional_this_week") return true;
      return !hasCalendarFields(task);
    })
    .map((task) => weeklyOptionShape(task, date));

  const optionalThisWeek = uniqueBy(weeklyOptionTasks, (row) => row.id)
    .sort((a, b) => compareDayEntries(a, b, date));

  function formatBullet(row, section) {
    const label = row.title;
    const dueDate = row.due_date || null;
    const parts = [];

    if (section === "scheduled") {
      const time = formatIsoRange(row.properties?.[TASK_FIELDS.scheduledStart], row.properties?.[TASK_FIELDS.scheduledEnd], date);
      return time
        ? `• **${label}** — ${time}`
        : `• **${label}**`;
    }

    if (section === "reschedule") {
      if (row.reason === "hard-time-needs-clear-time") {
        parts.push("needs a new exact time");
      } else if (row.reason === "routine-window-needs-clear-window") {
        parts.push("needs a clear time window");
      } else if (row.reason === "list-only-tomorrow") {
        parts.push(dueDate === date ? "due tomorrow" : "carry from today");
      } else if (dueDate && dueDate < date) {
        parts.push("overdue");
      } else if (dueDate === date) {
        parts.push("due tomorrow");
      }
      const slot = Array.isArray(row.preferred_slots) && row.preferred_slots.length > 0
        ? formatIsoRange(row.preferred_slots[0].start, row.preferred_slots[0].end, date)
        : null;
      if (slot) parts.push(`suggested ${slot}`);
      return `• **${label}**${parts.length > 0 ? ` — ${parts.join("; ")}` : ""}`;
    }

    if (section === "week") {
      const goal = Number(row.missing_needed || 0);
      if (goal > 0) return `• **${label}** (goal ${goal})`;
      return `• **${label}**`;
    }

    return `• **${label}**`;
  }

  const lines = ["Tomorrow"];
  if (rescheduleTomorrow.length > 0) {
    lines.push("", "Reschedule tomorrow:");
    for (const row of rescheduleTomorrow) lines.push(formatBullet(row, "reschedule"));
  }
  if (scheduledTomorrow.length > 0) {
    lines.push("", "Already scheduled:");
    for (const task of scheduledTomorrow) lines.push(formatBullet(task, "scheduled"));
  }
  if (optionalThisWeek.length > 0) {
    lines.push("", "Could pick from this week:");
    for (const row of optionalThisWeek) lines.push(formatBullet(row, "week"));
  }

  console.log(lines.join("\n").trim());
}

export function cmdPlanWeek(args) {
  const date = normalizeDateArg(args.date);
  const promoteLimit = args["promote-limit"] ? Number(args["promote-limit"]) : 3;
  const capacityMinutes = args["capacity-minutes"] ? Number(args["capacity-minutes"]) : 600;
  const tasks = mirrorRows("tasks").filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked");

  const weekTasks = tasks
    .filter((task) => task.properties[TASK_FIELDS.horizon] === "this week" || task.properties[TASK_FIELDS.horizon] === "today")
    .sort((a, b) => comparePlannedTasks(a, b, date));

  const promotable = tasks
    .filter((task) => {
      const horizon = task.properties[TASK_FIELDS.horizon];
      return horizon === "this month" || horizon === "this year";
    })
    .sort((a, b) => comparePlannedTasks(a, b, date))
    .slice(0, promoteLimit);

  const scheduledMinutes = weekTasks
    .filter((task) => hasCalendarFields(task))
    .reduce((sum, task) => {
      const start = Date.parse(dateStart(task.properties[TASK_FIELDS.scheduledStart]) || "");
      const end = Date.parse(dateStart(task.properties[TASK_FIELDS.scheduledEnd]) || "");
      if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
        return sum + Math.round((end - start) / 60000);
      }
      return sum + taskMinutes(task);
    }, 0);
  const unscheduledMinutes = weekTasks
    .filter((task) => !hasCalendarFields(task))
    .reduce((sum, task) => sum + taskMinutes(task), 0);
  const totalMinutes = scheduledMinutes + unscheduledMinutes;

  console.log(JSON.stringify({
    ok: true,
    action: "plan-week",
    date,
    capacity_minutes: capacityMinutes,
    totals: {
      week_tasks: weekTasks.length,
      scheduled_minutes: scheduledMinutes,
      unscheduled_minutes: unscheduledMinutes,
      total_minutes: totalMinutes,
      overload_minutes: Math.max(0, totalMinutes - capacityMinutes)
    },
    focus: weekTasks.slice(0, 5).map(taskReviewShape),
    promotable: promotable.map((task) => ({
      ...taskReviewShape(task),
      reason:
        task.properties[TASK_FIELDS.horizon] === "this month"
          ? "monthly task with near-term value"
          : "yearly task that should be concretized this week"
    })),
    notes: [
      "promotable is a shortlist from this month and this year ordered by urgency and priority",
      "capacity is heuristic and should be tuned for your real weekly bandwidth"
    ]
  }, null, 2));
}

export async function cmdSchedulingDecisions(args) {
  const date = normalizeDateArg(args.date);
  const days = Math.max(1, Number(args.days || 3));
  const limit = Math.max(1, Number(args.limit || 12));
  const windowEnd = addDays(date, days - 1);
  const dateWindow = Array.from({ length: days }, (_, index) => addDays(date, index));
  const tasks = resolveTaskRows(args)
    .filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked")
    .filter((task) => inferNeedsCalendar(task))
    .filter((task) => !hasCalendarFields(task))
    .filter((task) => (task.properties[TASK_FIELDS.schedulingMode] || null) !== "list_only")
    .filter((task) => inSchedulingDecisionWindow(task, date, windowEnd, days))
    .sort((a, b) => comparePlannedTasks(a, b, date))
    .slice(0, limit);
  const preferencesByTaskId = await loadSchedulingPreferenceMap(tasks, compactTaskLabel);
  const occupiedByDate = buildOccupiedByDate(
    resolveTaskRows(args).filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked"),
    dateWindow
  );

  const hardTimeReady = [];
  const hardTimeOrWindow = [];
  const flexibleToDiscuss = [];
  const weeklyRepeatMandatory = [];
  const weeklyRepeatOptional = [];

  for (const task of tasks) {
    const repeatPressure = weeklyRepeatPressure(task, date);
    if (repeatPressure) {
      if (repeatPressure.urgency === "mandatory_now") weeklyRepeatMandatory.push(repeatPressure);
      else weeklyRepeatOptional.push(repeatPressure);
    }

    const mode = task.properties[TASK_FIELDS.schedulingMode] || "flexible_block";
    const preference = preferencesByTaskId.get(task.id) || null;
    if (mode === "hard_time") {
      const proposal = hardTimeProposal(task, dateWindow, date);
      if (proposal) {
        hardTimeReady.push({
          ...schedulingDecisionShape(task, date, "hard-time-ready"),
          suggested_start: proposal.start,
          suggested_end: proposal.end,
          source: proposal.source
        });
      } else {
        hardTimeOrWindow.push(schedulingDecisionShape(task, date, "hard-time-needs-clear-time"));
      }
      continue;
    }
    if (mode === "routine_window") {
      hardTimeOrWindow.push(schedulingDecisionShape(task, date, "routine-window-needs-clear-window"));
      continue;
    }
    const preferenceSlots = flexibleSlotsForTask(task, dateWindow, occupiedByDate, 2, preference).map((slot) => ({
      start: slot.start,
      end: slot.end
    }));
    flexibleToDiscuss.push({
      ...schedulingDecisionShape(task, date, "flexible-needs-conversational-scheduling"),
      preferred_slots: preferenceSlots,
      preference_summary: preference?.summary || null
    });
  }

  console.log(JSON.stringify({
    ok: true,
    action: "scheduling-decisions",
    date,
    days,
    window_end: windowEnd,
    counts: {
      considered: tasks.length,
      hard_time_ready: hardTimeReady.length,
      hard_time_or_window: hardTimeOrWindow.length,
      flexible_to_discuss: flexibleToDiscuss.length,
      weekly_repeat_mandatory: weeklyRepeatMandatory.length,
      weekly_repeat_optional: weeklyRepeatOptional.length
    },
    hard_time_ready: hardTimeReady,
    hard_time_or_window: hardTimeOrWindow,
    flexible_to_discuss: flexibleToDiscuss,
    weekly_repeat_mandatory: weeklyRepeatMandatory,
    weekly_repeat_optional: weeklyRepeatOptional,
    notes: [
      "hard_time items may be scheduled by the agent when the intended time is already clear from task data, prior context, or an explicit user instruction",
      "flexible_block items should normally be surfaced in planning conversations instead of being silently auto-placed by code",
      "weekly grouped-repeat tasks should still be surfaced in daily planning; when remaining valid days equal remaining needed sessions, they should be treated as mandatory for this week"
    ]
  }, null, 2));
}

export function cmdScheduleSweep(args) {
  const date = normalizeDateArg(args.date);
  const days = args.days ? Number(args.days) : 3;
  const limit = args.limit ? Number(args.limit) : 8;
  const maxDailyMinutes = args["max-daily-minutes"] ? Number(args["max-daily-minutes"]) : 360;
  const apply = args.apply === true;
  const applyHardTime = args["apply-hard-time"] === true;
  const tasks = resolveTaskRows(args).filter((task) => isActiveTask(task) && task.properties[TASK_FIELDS.stage] !== "blocked");
  const dateWindow = Array.from({ length: Math.max(1, days) }, (_, index) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + index);
    return value.toISOString().slice(0, 10);
  });

  const occupiedByDate = new Map();
  const nowLocal = currentLocalDateTime();
  const scheduledMinutesByDate = new Map();
  for (const day of dateWindow) {
    const from = isoLocal(day, 0);
    const to = isoLocal(day, 23 * 60 + 59);
    const calendarLookup = fetchCalendarEventsInRange(from, to);
    assertCalendarLookup(calendarLookup, day, "calendar availability lookup");
    const intervals = [];
    for (const event of calendarLookup.events || []) {
      if (event.status === "cancelled") continue;
      const interval = eventIntervalForDate(event, day);
      if (interval) intervals.push(interval);
    }
    for (const task of tasks) {
      const interval = taskIntervalForDate(task, day);
      if (interval) {
        intervals.push(interval);
        scheduledMinutesByDate.set(day, (scheduledMinutesByDate.get(day) || 0) + (interval[1] - interval[0]));
      }
    }
    if (day === nowLocal.date) {
      intervals.push([0, Math.min(1440, nowLocal.minutes + 30)]);
    }
    occupiedByDate.set(day, mergeIntervals(intervals));
  }

  const candidates = tasks
    .filter((task) => {
      if (!inferNeedsCalendar(task)) return false;
      if (hasCalendarFields(task)) return false;
      const mode = task.properties[TASK_FIELDS.schedulingMode] || null;
      if (mode === "list_only") return false;
      const horizon = task.properties[TASK_FIELDS.horizon];
      const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
      return (
        horizon === "today" ||
        horizon === "this week" ||
        (dueDate && dueDate >= date && dueDate <= dateWindow[dateWindow.length - 1])
      );
    })
    .sort((a, b) => comparePlannedTasks(a, b, date))
    .slice(0, limit);

  const proposals = [];
  const skipped = [];
  const scheduled = [];

  for (const task of candidates) {
    const mode = task.properties[TASK_FIELDS.schedulingMode] || null;
    if (mode === "hard_time") {
      const proposal = hardTimeProposal(task, dateWindow, date);
      if (!proposal) {
        skipped.push({
          ...taskReviewShape(task),
          reason: "needs-explicit-time"
        });
        continue;
      }

      proposals.push(proposal);

      if (applyHardTime) {
        const hardSlots = hardTimeSlotsForTask(task, [proposal.date], occupiedByDate, 1);
        if (hardSlots.length === 0) {
          skipped.push({
            ...taskReviewShape(task),
            reason: "conflicts-with-existing-calendar"
          });
          continue;
        }
        const event = createCalendarEvent(task.title, proposal.start, proposal.end);
        updatePageProperties(task.id, {
          [TASK_FIELDS.scheduledStart]: dateProperty(proposal.start),
          [TASK_FIELDS.scheduledEnd]: dateProperty(proposal.end),
          [TASK_FIELDS.calendarEventId]: richTextProperty(event.id),
          [TASK_FIELDS.status]: selectProperty("scheduled"),
          [TASK_FIELDS.stage]: selectProperty("active"),
          [TASK_FIELDS.scheduleType]: selectProperty(task.properties[TASK_FIELDS.scheduleType] || "hard")
        });
        scheduled.push({
          ...proposal,
          calendar_event_id: event.id
        });
      }
      continue;
    }

    if (mode === "routine_window") {
      skipped.push({
        ...taskReviewShape(task),
        reason: "needs-explicit-window"
      });
      continue;
    }

    const durationMinutes = Math.max(15, taskDuration(task));
    const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
    let proposal = null;

    for (const day of dateWindow) {
      if (task.properties[TASK_FIELDS.horizon] === "today" && day !== date) continue;
      if (dueDate && day > dueDate) continue;

      const windows = candidateWindowsForDate(task, day);
      if (windows.length === 0) continue;
      if ((scheduledMinutesByDate.get(day) || 0) + durationMinutes > maxDailyMinutes) continue;
      const occupied = occupiedByDate.get(day) || [];
      const slot = findOpenSlot(occupied, windows, durationMinutes);
      if (!slot) continue;

      const [startMinutes, endMinutes] = slot;
      proposal = {
        page_id: task.id,
        title: task.title,
        date: day,
        start: isoLocal(day, startMinutes),
        end: isoLocal(day, endMinutes),
        duration_minutes: durationMinutes,
        scheduling_mode: mode || "flexible_block"
      };
      occupied.push([startMinutes, endMinutes]);
      occupiedByDate.set(day, mergeIntervals(occupied));
      scheduledMinutesByDate.set(day, (scheduledMinutesByDate.get(day) || 0) + durationMinutes);
      break;
    }

    if (!proposal) {
      skipped.push({
        ...taskReviewShape(task),
        reason: "no-open-slot-found"
      });
      continue;
    }

    proposals.push(proposal);

    if (apply) {
      skipped.push({
        ...taskReviewShape(task),
        reason: "flexible-auto-placement-disabled"
      });
      continue;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "schedule-sweep",
    date,
    days,
    limit,
    max_daily_minutes: maxDailyMinutes,
    apply,
    apply_hard_time: applyHardTime,
    counts: {
      candidates: candidates.length,
      proposed: proposals.length,
      scheduled: scheduled.length,
      skipped: skipped.length
    },
    proposals,
    scheduled,
    skipped,
    notes: [
      "schedule-sweep only auto-places hard_time tasks when calendar availability is confirmed",
      "routine_window tasks remain visible in needs_scheduling until explicit timing rules are set",
      "flexible_block tasks remain proposal-only and require an explicit human decision path"
    ]
  }, null, 2));
}

export function cmdProjectReview(args) {
  const projects = mirrorRows("projects");
  const tasks = mirrorRows("tasks").filter((task) => isActiveTask(task));
  const selectedProjects = resolveRows(projects, args, "project");

  const reviews = selectedProjects.map((project) => {
    const linkedTasks = tasks.filter((task) => (task.properties[TASK_FIELDS.project] || []).includes(project.id));
    const nextActions = linkedTasks.sort((a, b) => comparePlannedTasks(a, b, normalizeDateArg(args.date))).slice(0, 3);
    return {
      id: project.id,
      title: project.title,
      status: project.properties.Status || null,
      priority: project.properties.Priority || null,
      area: project.properties.Area || null,
      target_date: dateStart(project.properties["Target Date"]),
      goal_ids: project.properties.Goal || [],
      task_counts: {
        total: linkedTasks.length,
        by_horizon: countBy(linkedTasks, (task) => task.properties[TASK_FIELDS.horizon] || "none"),
        by_stage: countBy(linkedTasks, (task) => task.properties[TASK_FIELDS.stage] || "none")
      },
      next_actions: nextActions.map(taskReviewShape),
      health:
        linkedTasks.length === 0
          ? "no-linked-tasks"
          : linkedTasks.some((task) => task.properties[TASK_FIELDS.horizon] === "today" || task.properties[TASK_FIELDS.horizon] === "this week")
            ? "active"
            : "needs-near-term-task",
      summary: project.properties["Success Metric"] || ""
    };
  });

  console.log(JSON.stringify({
    ok: true,
    action: "project-review",
    count: reviews.length,
    reviews
  }, null, 2));
}

export function cmdGoalReview(args) {
  const goals = mirrorRows("goals");
  const projects = mirrorRows("projects");
  const tasks = mirrorRows("tasks").filter((task) => isActiveTask(task));
  const selectedGoals = resolveRows(goals, args, "goal");

  const reviews = selectedGoals.map((goal) => {
    const linkedProjects = projects.filter((project) => (project.properties.Goal || []).includes(goal.id));
    const linkedTasks = tasks.filter((task) => (task.properties[TASK_FIELDS.goal] || []).includes(goal.id));
    const nextActions = linkedTasks.sort((a, b) => comparePlannedTasks(a, b, normalizeDateArg(args.date))).slice(0, 4);
    return {
      id: goal.id,
      title: goal.title,
      status: goal.properties.Status || null,
      health: goal.properties.Health || null,
      horizon: goal.properties.Horizon || null,
      target_date: dateStart(goal.properties["Target Date"]),
      project_count: linkedProjects.length,
      projects: linkedProjects.map((project) => ({
        id: project.id,
        title: project.title,
        status: project.properties.Status || null,
        priority: project.properties.Priority || null
      })),
      task_counts: {
        total: linkedTasks.length,
        by_horizon: countBy(linkedTasks, (task) => task.properties[TASK_FIELDS.horizon] || "none"),
        by_stage: countBy(linkedTasks, (task) => task.properties[TASK_FIELDS.stage] || "none")
      },
      next_actions: nextActions.map(taskReviewShape),
      planning_notes: goal.properties["Planning Notes"] || "",
      success_metric: goal.properties["Success Metric"] || "",
      attention:
        goal.properties.Health === "at_risk"
          ? "needs-attention"
          : nextActions.length === 0
            ? "needs-derived-work"
            : "tracking"
    };
  });

  console.log(JSON.stringify({
    ok: true,
    action: "goal-review",
    count: reviews.length,
    reviews
  }, null, 2));
}
