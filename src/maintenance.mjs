import { TASK_FIELDS } from "./config.mjs";
import { dateStart, logCompletion, readCompletions } from "./history.mjs";
import { archivePage, updatePageProperties } from "./notion.mjs";
import {
  carryForwardProperties,
  clearCalendarProperties,
  defaultHorizonForCadence,
  hasCalendarFields,
  inferHorizon,
  inferNeedsCalendar,
  isDoneTask,
  mirrorRows,
  plusCadence,
  summary,
  triageProperties
} from "./tasks.mjs";
import { dateProperty, diffDays, normalizeDateArg, selectProperty } from "./util.mjs";

export function cmdShowCompleted(args) {
  const date = normalizeDateArg(args.date);
  const rows = readCompletions(date);
  console.log(JSON.stringify({ date, count: rows.length, rows }, null, 2));
}

export function cmdCloseDay(args) {
  const date = normalizeDateArg(args.date);
  const carryTo = args["carry-to"] || null;
  const tasks = mirrorRows("tasks").filter(
    (task) => task.properties[TASK_FIELDS.horizon] === "today" && task.archived !== true
  );

  const archivedOneTime = [];
  const rolledRecurring = [];
  const carryCandidates = [];
  const carriedForward = [];
  const blocked = [];

  for (const task of tasks) {
    const type = task.properties[TASK_FIELDS.type];
    const cadence = task.properties[TASK_FIELDS.cadence];

    if (isDoneTask(task)) {
      if (type === "recurring" && cadence && cadence !== "none") {
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
        rolledRecurring.push({ page_id: task.id, title: task.title, next_due: next });
        continue;
      }

      logCompletion(task, {
        completed_at: date,
        mode: "close-day-archive-done",
        source: "close-day"
      });
      archivePage(task.id);
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
        Boolean(task.properties[TASK_FIELDS.calendarEventId]);
      updatePageProperties(task.id, carryForwardProperties(carryTo, nextMissCount));
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
    carry_candidates: carryCandidates,
    carried_forward: carriedForward,
    blocked
  }, null, 2));
}

export function cmdTriageInbox(args) {
  const limit = args.limit ? Number(args.limit) : null;
  const baseDate = normalizeDateArg(args.date);
  const apply = args.apply === true;
  const inbox = mirrorRows("tasks").filter(
    (task) => task.properties[TASK_FIELDS.stage] === "inbox" && task.archived !== true
  );
  const selected = limit ? inbox.slice(0, limit) : inbox;

  const proposals = selected.map((task) => {
    const suggestedHorizon = inferHorizon(task, baseDate);
    const suggestedNeedsCalendar = inferNeedsCalendar(task);
    const suggestedStage =
      suggestedNeedsCalendar && !dateStart(task.properties[TASK_FIELDS.scheduledStart]) ? "planned" : "active";
    const reasons = [];
    if (dateStart(task.properties[TASK_FIELDS.dueDate])) reasons.push("due-date-driven");
    else if (task.properties[TASK_FIELDS.cadence]) reasons.push("cadence-driven");
    else if (task.properties[TASK_FIELDS.type] === "goal_generated") reasons.push("goal-derived");
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
  const tasks = mirrorRows("tasks");

  const missingScheduleAndEvent = [];
  const scheduledWithoutEvent = [];
  const staleEventWithoutSchedule = [];
  const completedWithEventRef = [];
  const invertedSchedule = [];
  const cleared = [];

  for (const task of tasks) {
    const status = task.properties[TASK_FIELDS.status];
    const stage = task.properties[TASK_FIELDS.stage];
    const needsCalendar = task.properties[TASK_FIELDS.needsCalendar] === true;
    const scheduledStart = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
    const scheduledEnd = dateStart(task.properties[TASK_FIELDS.scheduledEnd]);
    const eventId = task.properties[TASK_FIELDS.calendarEventId] || "";
    const archived = task.archived === true || stage === "archived";
    const base = summary(task);

    if (needsCalendar && !scheduledStart && !scheduledEnd && !eventId && status !== "done" && !archived) {
      missingScheduleAndEvent.push(base);
    }
    if (needsCalendar && (scheduledStart || scheduledEnd) && !eventId && status !== "done" && !archived) {
      scheduledWithoutEvent.push(base);
    }
    if (eventId && !scheduledStart && !scheduledEnd && status !== "done" && !archived) {
      staleEventWithoutSchedule.push(base);
      if (applyClearStale) {
        updatePageProperties(task.id, clearCalendarProperties());
        cleared.push({ page_id: task.id, title: task.title, reason: "event-ref-without-schedule" });
      }
    }
    if (eventId && (status === "done" || stage === "done" || archived)) {
      completedWithEventRef.push(base);
      if (applyClearStale) {
        updatePageProperties(task.id, clearCalendarProperties());
        cleared.push({ page_id: task.id, title: task.title, reason: "done-or-archived-with-event-ref" });
      }
    }
    if (scheduledStart && scheduledEnd && Date.parse(scheduledEnd) < Date.parse(scheduledStart)) {
      invertedSchedule.push(base);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    action: "reconcile-calendar",
    mode: "notion-state-only",
    external_calendar_check_available: false,
    missing_schedule_and_event: missingScheduleAndEvent,
    scheduled_without_event: scheduledWithoutEvent,
    stale_event_without_schedule: staleEventWithoutSchedule,
    completed_or_archived_with_event_ref: completedWithEventRef,
    inverted_schedule: invertedSchedule,
    cleared
  }, null, 2));
}

export function cmdReviewStale(args) {
  const date = normalizeDateArg(args.date);
  const missThreshold = args["miss-threshold"] ? Number(args["miss-threshold"]) : 3;
  const blockedDays = args["blocked-days"] ? Number(args["blocked-days"]) : 7;
  const tasks = mirrorRows("tasks").filter((task) => !isDoneTask(task));
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
    const lastEditedDaysAgo = task.last_edited_time ? diffDays(`${date}T00:00:00Z`, task.last_edited_time) : null;
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
