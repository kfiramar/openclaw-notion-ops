import { COMPLETIONS_ROOT, TASK_FIELDS } from "./config.mjs";
import { appendJsonLine, normalizeDateArg, readJsonLines } from "./util.mjs";

export function completionLogPath(date) {
  return `${COMPLETIONS_ROOT}/${date}.jsonl`;
}

export function dateStart(value) {
  return value?.start || null;
}

export function taskRecord(task) {
  return {
    page_id: task.id,
    title: task.title,
    archived: Boolean(task.archived),
    type: task.properties[TASK_FIELDS.type] || null,
    stage: task.properties[TASK_FIELDS.stage] || null,
    status: task.properties[TASK_FIELDS.status] || null,
    horizon: task.properties[TASK_FIELDS.horizon] || null,
    priority: task.properties[TASK_FIELDS.priority] || null,
    cadence: task.properties[TASK_FIELDS.cadence] || null,
    due_date: dateStart(task.properties[TASK_FIELDS.dueDate]),
    next_due_at: dateStart(task.properties[TASK_FIELDS.nextDueAt]),
    scheduled_start: dateStart(task.properties[TASK_FIELDS.scheduledStart]),
    scheduled_end: dateStart(task.properties[TASK_FIELDS.scheduledEnd]),
    needs_calendar: task.properties[TASK_FIELDS.needsCalendar] === true,
    calendar_event_id: task.properties[TASK_FIELDS.calendarEventId] || null,
    project_ids: task.properties[TASK_FIELDS.project] || [],
    goal_ids: task.properties[TASK_FIELDS.goal] || []
  };
}

export function logCompletion(task, meta = {}) {
  const completedAt = normalizeDateArg(meta.completed_at || meta.completedAt);
  appendJsonLine(completionLogPath(completedAt), {
    completed_at: completedAt,
    logged_at: new Date().toISOString(),
    source: meta.source || "notion-board-ops",
    mode: meta.mode || "completed",
    next_due: meta.next_due || null,
    ...taskRecord(task)
  });
}

export function readCompletions(date) {
  return readJsonLines(completionLogPath(normalizeDateArg(date)));
}
