#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE_ROOT =
  process.env.OPENCLAW_WORKSPACE || "/docker/openclaw-pma3/data/.openclaw/workspace-personal";
const WRAPPER_PATH = path.join(WORKSPACE_ROOT, "lifestyle-ops.mjs");
const LIB_ROOT = path.join(WORKSPACE_ROOT, "lifestyle-ops-lib");
const CONTAINER = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
const CALENDAR_ID = process.env.PRIMARY_CALENDAR_ID || "suukpehoy@gmail.com";
const BASE_DATE = process.env.E2E_BASE_DATE || "2026-03-22";
const NEXT_DAY = "2026-03-23";
const NEXT_WEEK = "2026-03-29";
const NEXT_MONTH = "2026-04-01";
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const prefix = `E2E Smoke ${stamp}`;

const createdTaskIds = [];
const createdEventIds = new Set();
const results = [];

const { archivePage } = await import(pathToFileURL(path.join(LIB_ROOT, "notion.mjs")).href);

function shellJson(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = String(error.stdout || "").trim();
    const stderr = String(error.stderr || "").trim();
    const detail = stdout || stderr || error.message;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}

function runWrapper(args) {
  return shellJson("node", [WRAPPER_PATH, ...args]);
}

function runGog(args) {
  return shellJson("docker", ["exec", CONTAINER, "gog", ...args]);
}

function unwrapEvent(payload) {
  return payload?.event || payload;
}

function inspectTask(pageId) {
  return runWrapper(["inspect-task", "--page-id", pageId]);
}

function verifySchedule(pageId) {
  return runWrapper(["verify-schedule", "--page-id", pageId]);
}

function eventFetch(eventId) {
  return unwrapEvent(runGog(["calendar", "event", CALENDAR_ID, eventId, "--json"]));
}

function eventCreate(summary, start, end) {
  const event = unwrapEvent(runGog([
    "calendar",
    "create",
    CALENDAR_ID,
    "--summary",
    summary,
    "--from",
    start,
    "--to",
    end,
    "--json"
  ]));
  createdEventIds.add(event.id);
  return event;
}

function eventDelete(eventId) {
  if (!eventId) return null;
  try {
    return runGog(["calendar", "delete", CALENDAR_ID, eventId, "--force", "--json"]);
  } catch (error) {
    if (/410|404|not found|deleted/i.test(error.message)) return null;
    throw error;
  }
}

function title(suffix) {
  return `${prefix} ${suffix}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameInstant(a, b) {
  const aTs = Date.parse(a || "");
  const bTs = Date.parse(b || "");
  return !Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs === bTs;
}

function fieldDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.start) return value.start;
  return null;
}

function recordTask(pageId) {
  if (pageId) createdTaskIds.push(pageId);
  return pageId;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: error.message
    });
  }
}

async function cleanup() {
  for (const pageId of createdTaskIds) {
    try {
      const task = inspectTask(pageId);
      const eventId = task.properties?.["Calendar Event ID"] || "";
      if (eventId || task.properties?.["Scheduled Start"] || task.properties?.["Scheduled End"]) {
        try {
          runWrapper(["remove-schedule", "--page-id", pageId]);
        } catch {
          // Best-effort cleanup only.
        }
      }
      await archivePage(pageId);
    } catch {
      // Best-effort cleanup only.
    }
  }

  for (const eventId of createdEventIds) {
    try {
      eventDelete(eventId);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

await step("sync-and-read-views", async () => {
  const sync = runWrapper(["sync"]);
  assert(sync.ok === true, "sync failed");

  const views = ["today", "week", "month", "year", "inbox", "blocked", "overdue", "needs_scheduling", "execution", "calendar"]
    .map((view) => runWrapper(["show", "--view", view]));
  assert(views.length === 10, "show views did not run");

  const projects = runWrapper(["list-projects"]);
  const goals = runWrapper(["list-goals"]);
  assert(projects.count > 0, "list-projects returned no rows");
  assert(goals.count > 0, "list-goals returned no rows");

  const projectReview = runWrapper(["project-review", "--page-id", projects.rows[0].id]);
  const goalReview = runWrapper(["goal-review", "--page-id", goals.rows[0].id]);
  const dayPlan = runWrapper(["plan-day", "--date", BASE_DATE]);
  const weekPlan = runWrapper(["plan-week", "--date", BASE_DATE]);

  assert(projectReview.count === 1, "project-review did not return one review");
  assert(goalReview.count === 1, "goal-review did not return one review");
  assert(dayPlan.ok === true, "plan-day failed");
  assert(weekPlan.ok === true, "plan-week failed");

  return {
    sync_mode: sync.mode,
    project_count: projects.count,
    goal_count: goals.count,
    today_count: views[0].count,
    week_focus: weekPlan.focus?.length || 0
  };
});

await step("triage-block-review-stale", async () => {
  const add = runWrapper(["add-task", "--title", title("Inbox"), "--date", BASE_DATE]);
  const pageId = recordTask(add.page_id);

  const triage = runWrapper(["triage-inbox", "--page-id", pageId, "--date", BASE_DATE, "--apply"]);
  assert(triage.applied_rows?.length === 1, "triage-inbox did not apply");

  const afterTriage = inspectTask(pageId);
  assert(afterTriage.properties.Stage !== "inbox", "triaged task stayed in inbox");

  runWrapper(["block-task", "--page-id", pageId, "--reason", "waiting on smoke-test dependency"]);
  const blocked = inspectTask(pageId);
  assert(blocked.properties.Stage === "blocked", "block-task did not set blocked stage");

  const stale = runWrapper(["review-stale", "--page-id", pageId, "--date", BASE_DATE, "--blocked-days", "0"]);
  assert(stale.blocked_stale?.length === 1, "review-stale did not flag blocked task");

  return {
    page_id: pageId,
    suggested_horizon: triage.applied_rows[0].suggested_horizon,
    blocked: stale.blocked_stale.length
  };
});

await step("promote-defer-move", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Workflow"),
    "--date",
    BASE_DATE,
    "--horizon",
    "this month",
    "--stage",
    "planned"
  ]);
  const pageId = recordTask(add.page_id);

  runWrapper(["promote", "--page-id", pageId, "--to", "today"]);
  let task = inspectTask(pageId);
  assert(task.properties.Horizon === "today", "promote did not move task to today");

  runWrapper(["defer", "--page-id", pageId, "--to", "this month", "--increment-miss"]);
  task = inspectTask(pageId);
  assert(task.properties.Horizon === "this month", "defer did not move task back to month");
  assert(Number(task.properties["Miss Count"] || 0) === 1, "defer did not increment miss count");

  runWrapper([
    "move-task",
    "--page-id",
    pageId,
    "--horizon",
    "this week",
    "--stage",
    "planned",
    "--due-date",
    "2026-03-24"
  ]);
  task = inspectTask(pageId);
  assert(task.properties.Horizon === "this week", "move-task did not update horizon");
  assert(task.properties.Stage === "planned", "move-task did not update stage");
  assert(fieldDate(task.properties["Due Date"]) === "2026-03-24", "move-task did not set due date");

  return {
    page_id: pageId,
    miss_count: task.properties["Miss Count"] || 0
  };
});

await step("close-day-carry-clears-calendar", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Close Day Carry"),
    "--date",
    BASE_DATE,
    "--horizon",
    "today",
    "--stage",
    "active"
  ]);
  const pageId = recordTask(add.page_id);

  const set = runWrapper([
    "set-schedule",
    "--page-id",
    pageId,
    "--start",
    "2026-03-22T09:00:00+02:00",
    "--end",
    "2026-03-22T09:30:00+02:00"
  ]);
  const oldEventId = set.calendar_event_id;
  assert(verifySchedule(pageId).synced === true, "pre-carry task schedule was not synced");

  const closeDay = runWrapper(["close-day", "--page-id", pageId, "--date", BASE_DATE, "--carry-to", "this week"]);
  assert(closeDay.carried_forward?.length === 1, "close-day did not carry the task forward");

  const task = inspectTask(pageId);
  assert(task.properties.Horizon === "this week", "close-day carry did not change horizon");
  assert(Number(task.properties["Miss Count"] || 0) === 1, "close-day carry did not increment miss count");
  assert(!task.properties["Calendar Event ID"], "close-day carry left calendar link behind");
  assert(!task.properties["Scheduled Start"], "close-day carry left scheduled start behind");

  let eventState = "missing";
  try {
    const event = eventFetch(oldEventId);
    eventState = event.status || "found";
  } catch {
    eventState = "missing";
  }

  return {
    page_id: pageId,
    old_event_id: oldEventId,
    event_state: eventState
  };
});

await step("close-day-archives-done-one-time", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Close Day Archive"),
    "--date",
    BASE_DATE,
    "--horizon",
    "today",
    "--stage",
    "active"
  ]);
  const pageId = recordTask(add.page_id);

  runWrapper(["complete-task", "--page-id", pageId, "--when", BASE_DATE, "--archive", "false"]);
  const closeDay = runWrapper(["close-day", "--page-id", pageId, "--date", BASE_DATE]);
  assert(closeDay.archived_one_time?.length === 1, "close-day did not archive the done one-time task");

  const task = inspectTask(pageId);
  assert(task.archived === true, "task was not archived after close-day");

  return { page_id: pageId };
});

await step("cadence-roll-forward", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Cadence Weekly"),
    "--date",
    BASE_DATE,
    "--horizon",
    "today",
    "--stage",
    "active",
    "--repeat-mode",
    "cadence",
    "--cadence",
    "weekly"
  ]);
  const pageId = recordTask(add.page_id);

  const complete = runWrapper(["complete-task", "--page-id", pageId, "--when", BASE_DATE]);
  assert(complete.mode === "recurring-roll-forward", "cadence task did not roll forward");

  const task = inspectTask(pageId);
  assert(fieldDate(task.properties["Due Date"]) === NEXT_WEEK, "cadence task due date did not move to next week");
  assert(fieldDate(task.properties["Next Due At"]) === NEXT_WEEK, "cadence task next due did not move to next week");
  assert(task.properties.Status === "todo", "cadence task did not return to todo");

  return { page_id: pageId, next_due: fieldDate(task.properties["Due Date"]) };
});

await step("manual-repeat-weekly-refresh", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Manual Weekly"),
    "--date",
    BASE_DATE,
    "--horizon",
    "this week",
    "--stage",
    "active",
    "--repeat-mode",
    "manual_repeat",
    "--cadence",
    "weekly",
    "--repeat-window",
    "week",
    "--repeat-target-count",
    "2"
  ]);
  const pageId = recordTask(add.page_id);

  runWrapper(["complete-task", "--page-id", pageId, "--when", BASE_DATE]);
  let task = inspectTask(pageId);
  assert(Number(task.properties["Repeat Progress"] || 0) === 1, "manual weekly progress did not increment to 1");
  assert(task.properties.Status === "todo", "manual weekly task should remain todo before target");

  runWrapper(["complete-task", "--page-id", pageId, "--when", BASE_DATE]);
  task = inspectTask(pageId);
  assert(task.properties.Status === "done", "manual weekly task did not reach done at target");

  const refresh = runWrapper([
    "refresh-manual-repeat",
    "--page-id",
    pageId,
    "--date",
    NEXT_WEEK,
    "--apply"
  ]);
  assert(refresh.refreshed?.length === 1, "refresh-manual-repeat did not refresh weekly task");

  task = inspectTask(pageId);
  assert(Number(task.properties["Repeat Progress"] || 0) === 0, "manual weekly progress did not reset");
  assert(fieldDate(task.properties["Due Date"]) === NEXT_WEEK, "manual weekly due date did not reset to next week");
  assert(task.properties.Status === "todo", "manual weekly task did not return to todo");

  return { page_id: pageId, next_due: fieldDate(task.properties["Due Date"]) };
});

await step("manual-repeat-monthly-refresh", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Manual Monthly"),
    "--date",
    BASE_DATE,
    "--horizon",
    "this month",
    "--stage",
    "active",
    "--repeat-mode",
    "manual_repeat",
    "--cadence",
    "monthly",
    "--repeat-window",
    "month",
    "--repeat-target-count",
    "1"
  ]);
  const pageId = recordTask(add.page_id);

  runWrapper(["complete-task", "--page-id", pageId, "--when", BASE_DATE]);
  const refresh = runWrapper([
    "refresh-manual-repeat",
    "--page-id",
    pageId,
    "--date",
    NEXT_MONTH,
    "--apply"
  ]);
  assert(refresh.refreshed?.length === 1, "refresh-manual-repeat did not refresh monthly task");

  const task = inspectTask(pageId);
  assert(fieldDate(task.properties["Due Date"]) === NEXT_MONTH, "manual monthly due date did not move to next month");
  assert(Number(task.properties["Repeat Progress"] || 0) === 0, "manual monthly progress did not reset");

  return { page_id: pageId, next_due: fieldDate(task.properties["Due Date"]) };
});

await step("calendar-lifecycle", async () => {
  const capture = runWrapper([
    "capture",
    "--title",
    title("Calendar Lifecycle"),
    "--date",
    BASE_DATE,
    "--horizon",
    "today",
    "--due-date",
    BASE_DATE,
    "--start",
    "2026-03-22T10:00:00+02:00",
    "--end",
    "2026-03-22T10:30:00+02:00",
    "--needs-calendar",
    "true",
    "--scheduling-mode",
    "flexible_block"
  ]);
  const pageId = recordTask(capture.page_id);
  const firstEventId = capture.calendar_event_id;
  createdEventIds.add(firstEventId);

  let verify = verifySchedule(pageId);
  assert(verify.synced === true, "captured scheduled task was not synced");
  let event = eventFetch(firstEventId);
  assert(event.id === firstEventId, "captured event was not fetchable");

  const reschedule = runWrapper([
    "reschedule-task",
    "--page-id",
    pageId,
    "--start",
    "2026-03-22T10:45:00+02:00",
    "--end",
    "2026-03-22T11:15:00+02:00"
  ]);
  createdEventIds.add(reschedule.calendar_event_id);
  verify = verifySchedule(pageId);
  assert(verify.synced === true, "rescheduled task was not synced");
  event = eventFetch(reschedule.calendar_event_id);
  assert(sameInstant(event.start?.dateTime, "2026-03-22T10:45:00+02:00"), "calendar event start did not update");

  const unlink = runWrapper(["unlink-schedule", "--page-id", pageId]);
  assert(unlink.removed_link === true, "unlink-schedule did not remove the link");
  let task = inspectTask(pageId);
  assert(!task.properties["Calendar Event ID"], "unlink-schedule left event id behind");
  assert(Boolean(task.properties["Scheduled Start"]), "unlink-schedule removed the task schedule");

  const reconcile = runWrapper(["reconcile-calendar", "--page-id", pageId, "--apply-link-matches"]);
  assert(reconcile.linked?.length === 1, "reconcile-calendar did not relink the matching event");
  verify = verifySchedule(pageId);
  assert(verify.synced === true, "relinked schedule was not synced");

  const linkedEventId = verify.calendar_event_id;
  runWrapper(["remove-schedule", "--page-id", pageId]);
  task = inspectTask(pageId);
  assert(!task.properties["Calendar Event ID"], "remove-schedule left calendar id behind");
  assert(!task.properties["Scheduled Start"], "remove-schedule left scheduled start behind");

  let removedEventState = "missing";
  try {
    const removedEvent = eventFetch(linkedEventId);
    removedEventState = removedEvent.status || "found";
  } catch {
    removedEventState = "missing";
  }

  const set = runWrapper([
    "set-schedule",
    "--page-id",
    pageId,
    "--start",
    "2026-03-22T12:00:00+02:00",
    "--end",
    "2026-03-22T12:30:00+02:00"
  ]);
  createdEventIds.add(set.calendar_event_id);
  verify = verifySchedule(pageId);
  assert(verify.synced === true, "set-schedule did not produce a synced task");

  return {
    page_id: pageId,
    removed_event_state: removedEventState,
    final_event_id: set.calendar_event_id
  };
});

await step("explicit-link-schedule", async () => {
  const summary = title("Direct Link");
  const start = "2026-03-22T14:00:00+02:00";
  const end = "2026-03-22T14:30:00+02:00";
  const event = eventCreate(summary, start, end);

  const add = runWrapper([
    "add-task",
    "--title",
    summary,
    "--date",
    BASE_DATE,
    "--horizon",
    "today",
    "--stage",
    "active"
  ]);
  const pageId = recordTask(add.page_id);

  const link = runWrapper([
    "link-schedule",
    "--page-id",
    pageId,
    "--event-id",
    event.id,
    "--start",
    start,
    "--end",
    end
  ]);
  assert(link.calendar_event_id === event.id, "link-schedule did not link the requested event");
  assert(verifySchedule(pageId).synced === true, "linked schedule was not synced");

  return {
    page_id: pageId,
    calendar_event_id: event.id
  };
});

await step("reconcile-clear-stale-missing-external-event", async () => {
  const capture = runWrapper([
    "capture",
    "--title",
    title("Stale External"),
    "--date",
    BASE_DATE,
    "--horizon",
    "today",
    "--due-date",
    BASE_DATE,
    "--start",
    "2026-03-22T15:00:00+02:00",
    "--end",
    "2026-03-22T15:30:00+02:00",
    "--needs-calendar",
    "true",
    "--scheduling-mode",
    "flexible_block"
  ]);
  const pageId = recordTask(capture.page_id);
  const eventId = capture.calendar_event_id;
  createdEventIds.add(eventId);
  assert(verifySchedule(pageId).synced === true, "stale-external setup did not start synced");

  eventDelete(eventId);

  const reconcile = runWrapper(["reconcile-calendar", "--page-id", pageId, "--apply-clear-stale"]);
  assert(reconcile.cleared?.length === 1, "reconcile-calendar did not clear stale external event");

  const task = inspectTask(pageId);
  assert(!task.properties["Calendar Event ID"], "stale external clear left event id behind");
  assert(!task.properties["Scheduled Start"], "stale external clear left schedule behind");

  return {
    page_id: pageId,
    cleared_reason: reconcile.cleared[0].reason
  };
});

await step("schedule-sweep-hard-time", async () => {
  const capture = runWrapper([
    "capture",
    "--title",
    title("Hard Time"),
    "--date",
    BASE_DATE,
    "--horizon",
    "this week",
    "--due-date",
    NEXT_DAY,
    "--needs-calendar",
    "true",
    "--scheduling-mode",
    "hard_time",
    "--schedule-type",
    "hard",
    "--notes",
    "21:30-22:00"
  ]);
  const pageId = recordTask(capture.page_id);

  const decisions = runWrapper([
    "scheduling-decisions",
    "--page-id",
    pageId,
    "--date",
    BASE_DATE,
    "--days",
    "2"
  ]);
  assert(decisions.hard_time_ready?.length === 1, "hard-time task was not surfaced as ready");

  const sweep = runWrapper([
    "schedule-sweep",
    "--page-id",
    pageId,
    "--date",
    BASE_DATE,
    "--days",
    "2",
    "--apply-hard-time"
  ]);
  assert(sweep.scheduled?.length === 1, "schedule-sweep did not auto-place hard-time task");
  createdEventIds.add(sweep.scheduled[0].calendar_event_id);

  const verify = verifySchedule(pageId);
  assert(verify.synced === true, "hard-time schedule-sweep result was not synced");

  return {
    page_id: pageId,
    scheduled_start: verify.task_schedule.start
  };
});

await step("schedule-sweep-flexible-block", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Flexible Sweep"),
    "--date",
    BASE_DATE,
    "--horizon",
    "this week",
    "--stage",
    "active",
    "--due-date",
    NEXT_DAY,
    "--needs-calendar",
    "true",
    "--scheduling-mode",
    "flexible_block",
    "--estimated-minutes",
    "30"
  ]);
  const pageId = recordTask(add.page_id);

  const decisions = runWrapper([
    "scheduling-decisions",
    "--page-id",
    pageId,
    "--date",
    BASE_DATE,
    "--days",
    "2"
  ]);
  assert(decisions.flexible_to_discuss?.length === 1, "flexible block was not surfaced for discussion");

  const sweep = runWrapper([
    "schedule-sweep",
    "--page-id",
    pageId,
    "--date",
    BASE_DATE,
    "--days",
    "2",
    "--apply",
    "--max-daily-minutes",
    "600"
  ]);
  assert(sweep.scheduled?.length === 1, "schedule-sweep did not place flexible block");
  createdEventIds.add(sweep.scheduled[0].calendar_event_id);

  const verify = verifySchedule(pageId);
  assert(verify.synced === true, "flexible block schedule-sweep result was not synced");

  return {
    page_id: pageId,
    scheduled_start: verify.task_schedule.start
  };
});

await step("routine-window-stays-manual", async () => {
  const add = runWrapper([
    "add-task",
    "--title",
    title("Routine Window"),
    "--date",
    BASE_DATE,
    "--horizon",
    "this week",
    "--stage",
    "active",
    "--due-date",
    NEXT_DAY,
    "--needs-calendar",
    "true",
    "--scheduling-mode",
    "routine_window"
  ]);
  const pageId = recordTask(add.page_id);

  const decisions = runWrapper([
    "scheduling-decisions",
    "--page-id",
    pageId,
    "--date",
    BASE_DATE,
    "--days",
    "2"
  ]);
  assert(decisions.hard_time_or_window?.length === 1, "routine-window task was not surfaced");
  assert(
    decisions.hard_time_or_window[0].reason === "routine-window-needs-clear-window",
    "routine-window task surfaced with the wrong reason"
  );

  const sweep = runWrapper([
    "schedule-sweep",
    "--page-id",
    pageId,
    "--date",
    BASE_DATE,
    "--days",
    "2",
    "--apply"
  ]);
  assert(sweep.skipped?.length === 1, "routine-window task was not skipped");
  assert(sweep.skipped[0].reason === "needs-explicit-window", "routine-window task skipped with wrong reason");

  return { page_id: pageId };
});

await step("show-completed-log", async () => {
  const completed = runWrapper(["show-completed", "--date", BASE_DATE]);
  const titles = new Set(completed.rows.map((row) => row.title));
  assert(titles.has(title("Cadence Weekly")), "completion log missing cadence entry");
  assert(titles.has(title("Manual Weekly")), "completion log missing weekly manual-repeat entry");
  assert(titles.has(title("Manual Monthly")), "completion log missing monthly manual-repeat entry");

  return {
    date: BASE_DATE,
    count: completed.count
  };
});

await cleanup();

const failures = results.filter((item) => item.ok === false);
console.log(JSON.stringify({
  ok: failures.length === 0,
  workspace: WORKSPACE_ROOT,
  base_date: BASE_DATE,
  prefix,
  counts: {
    steps: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    created_tasks: createdTaskIds.length
  },
  results
}, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
