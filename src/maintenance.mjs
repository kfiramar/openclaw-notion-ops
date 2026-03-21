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
  isActiveTask,
  isDoneTask,
  mirrorRows,
  plusCadence,
  selectRow,
  priorityWeight,
  summary,
  triageProperties
} from "./tasks.mjs";
import { dateProperty, diffDays, normalizeDateArg, selectProperty } from "./util.mjs";

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
  if (task.properties[TASK_FIELDS.type] === "goal_generated") score += 8;
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
    const row = rows.find((item) => item.id === args["page-id"]);
    if (!row) throw new Error(`no ${label} matched page id ${args["page-id"]}`);
    return [row];
  }
  if (args.match) return [selectRow(rows, args.match, label)];
  return rows;
}

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
    .reduce((sum, task) => sum + taskMinutes(task), 0);
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
