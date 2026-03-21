import { TASK_FIELDS } from "./config.mjs";
import { logCompletion } from "./history.mjs";
import {
  archivePage,
  kickMirrorSync,
  notionRequest,
  runMirrorSync,
  updatePageProperties
} from "./notion.mjs";
import {
  board,
  defaultHorizonForCadence,
  listRows,
  matchTask,
  mirrorRows,
  plusCadence,
  resolveRelationArg,
  resolveTaskView,
  summary
} from "./tasks.mjs";
import {
  boolOrNull,
  checkboxProperty,
  dateProperty,
  isoDate,
  normalizeDateArg,
  numberProperty,
  relationProperty,
  richTextProperty,
  selectProperty,
  titleProperty
} from "./util.mjs";

export function cmdShow(args) {
  const rows = mirrorRows("tasks");
  const rawView = args.view || "today";
  const { view, spec } = resolveTaskView(rawView);
  const result = rows.filter(spec.filter).map(summary);
  console.log(JSON.stringify({ view, count: result.length, rows: result }, null, 2));
}

export function cmdInspectTask(args) {
  const task = matchTask(args);
  console.log(JSON.stringify(task, null, 2));
}

export function cmdAddTask(args) {
  const b = board();
  const title = args.title || args._.join(" ");
  if (!title) throw new Error('usage: add-task --title "..." [--horizon ...]');

  const payload = {
    parent: { data_source_id: b.databases.tasks.data_source_id },
    properties: {
      [TASK_FIELDS.title]: titleProperty(title),
      [TASK_FIELDS.stage]: selectProperty(args.stage || "inbox"),
      [TASK_FIELDS.status]: selectProperty(args.status || "todo"),
      [TASK_FIELDS.horizon]: selectProperty(args.horizon || "this week"),
      [TASK_FIELDS.type]: selectProperty(args.type || "one_time"),
      [TASK_FIELDS.priority]: selectProperty(args.priority || "medium"),
      [TASK_FIELDS.needsCalendar]: checkboxProperty(boolOrNull(args["needs-calendar"]) ?? false),
      [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || null),
      [TASK_FIELDS.estimatedMinutes]: numberProperty(args["estimated-minutes"]),
      [TASK_FIELDS.energy]: selectProperty(args.energy || null),
      [TASK_FIELDS.cadence]: selectProperty(args.cadence || null),
      [TASK_FIELDS.dueDate]: dateProperty(isoDate(args["due-date"] || null)),
      [TASK_FIELDS.nextDueAt]: dateProperty(isoDate(args["next-due-at"] || null)),
      [TASK_FIELDS.reviewNotes]: richTextProperty(args.notes || ""),
      [TASK_FIELDS.project]: relationProperty(resolveRelationArg("projects", args, "project", "project-id")),
      [TASK_FIELDS.goal]: relationProperty(resolveRelationArg("goals", args, "goal", "goal-id"))
    }
  };

  const out = notionRequest("POST", "/v1/pages", payload, true);
  kickMirrorSync();
  console.log(JSON.stringify({ ok: true, action: "add-task", page_id: out.id, title }, null, 2));
}

export function cmdMoveTask(args) {
  const task = matchTask(args);
  updatePageProperties(task.id, {
    [TASK_FIELDS.horizon]: args.horizon ? selectProperty(args.horizon) : undefined,
    [TASK_FIELDS.stage]: args.stage ? selectProperty(args.stage) : undefined,
    [TASK_FIELDS.status]: args.status ? selectProperty(args.status) : undefined,
    [TASK_FIELDS.dueDate]: args["due-date"] ? dateProperty(args["due-date"]) : undefined,
    [TASK_FIELDS.scheduledStart]: args["scheduled-start"] ? dateProperty(args["scheduled-start"]) : undefined,
    [TASK_FIELDS.scheduledEnd]: args["scheduled-end"] ? dateProperty(args["scheduled-end"]) : undefined,
    [TASK_FIELDS.needsCalendar]:
      args["needs-calendar"] !== undefined ? checkboxProperty(boolOrNull(args["needs-calendar"])) : undefined,
    [TASK_FIELDS.scheduleType]: args["schedule-type"] ? selectProperty(args["schedule-type"]) : undefined
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
      scheduled_start: args["scheduled-start"] || null,
      scheduled_end: args["scheduled-end"] || null,
      needs_calendar: args["needs-calendar"] ?? null,
      schedule_type: args["schedule-type"] || null
    }
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
  const type = task.properties[TASK_FIELDS.type];

  if (type === "recurring" && cadence && cadence !== "none") {
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

  const archive = args.archive !== "false";
  if (archive) {
    logCompletion(task, {
      completed_at: when,
      mode: "archived",
      source: "complete-task"
    });
    archivePage(task.id);
    console.log(JSON.stringify({ ok: true, action: "complete-task", mode: "archived", page_id: task.id, task: task.title }, null, 2));
    return;
  }

  logCompletion(task, {
    completed_at: when,
    mode: "done",
    source: "complete-task"
  });
  updatePageProperties(task.id, {
    [TASK_FIELDS.status]: selectProperty("done"),
    [TASK_FIELDS.stage]: selectProperty("done"),
    [TASK_FIELDS.lastCompletedAt]: dateProperty(when)
  });
  console.log(JSON.stringify({ ok: true, action: "complete-task", mode: "done", page_id: task.id, task: task.title }, null, 2));
}

export function cmdSetSchedule(args) {
  const task = matchTask(args);
  if (!args.start || !args.end) throw new Error('usage: set-schedule --match "..." --start <ISO> --end <ISO>');
  updatePageProperties(task.id, {
    [TASK_FIELDS.scheduledStart]: dateProperty(args.start),
    [TASK_FIELDS.scheduledEnd]: dateProperty(args.end),
    [TASK_FIELDS.needsCalendar]:
      args["needs-calendar"] !== undefined ? checkboxProperty(boolOrNull(args["needs-calendar"])) : checkboxProperty(true),
    [TASK_FIELDS.scheduleType]: selectProperty(args["schedule-type"] || task.properties[TASK_FIELDS.scheduleType] || "soft"),
    [TASK_FIELDS.status]: selectProperty("scheduled"),
    [TASK_FIELDS.stage]: selectProperty(args.stage || task.properties[TASK_FIELDS.stage] || "planned"),
    [TASK_FIELDS.calendarEventId]:
      args["calendar-event-id"] !== undefined ? richTextProperty(args["calendar-event-id"]) : undefined
  });
  console.log(JSON.stringify({ ok: true, action: "set-schedule", page_id: task.id, task: task.title, start: args.start, end: args.end }, null, 2));
}

export function cmdSync() {
  runMirrorSync();
  console.log(JSON.stringify({ ok: true, action: "sync" }, null, 2));
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
