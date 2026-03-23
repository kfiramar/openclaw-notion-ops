import { TASK_FIELDS, TELEGRAM_POLL_ACCOUNT, TELEGRAM_POLL_TARGET } from "./config.mjs";
import { deleteCalendarEvent } from "./calendar.mjs";
import { dateStart, logCompletion } from "./history.mjs";
import { compactTaskLabel, includeInHumanSummary } from "./human-summary.mjs";
import { archivePage, getPage, updatePageProperties } from "./notion.mjs";
import {
  MAX_TELEGRAM_POLL_OPTIONS,
  generateBatchId,
  generatePollRunId,
  listPollStates,
  normalizeAccountId,
  readPollAnswerEvents,
  readPollState,
  writePollState
} from "./polls.mjs";
import { sendTelegramPoll, stopTelegramPoll } from "./telegram.mjs";
import {
  calendarRefsOf,
  carryForwardProperties,
  clearCalendarProperties,
  defaultHorizonForCadence,
  isActiveTask,
  isAutoCompleteWhenScheduledTask,
  isDoneTask,
  mirrorRows,
  plusCadence,
  priorityWeight,
  repeatModeOf
} from "./tasks.mjs";
import { dateProperty, normalizeDateArg, numberProperty, selectProperty } from "./util.mjs";

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function deleteCalendarRefs(task) {
  const refs = calendarRefsOf(task);
  for (const ref of refs) {
    if (ref.event_id) deleteCalendarEvent(ref.event_id);
  }
  return refs;
}

function labelPriority(task) {
  const scheduled = dateStart(task.properties[TASK_FIELDS.scheduledStart]);
  return {
    scheduled_rank: scheduled ? 0 : 1,
    scheduled_start: scheduled || "",
    priority: priorityWeight(task.properties[TASK_FIELDS.priority]),
    title: task.title || ""
  };
}

function compareCandidates(a, b) {
  const left = labelPriority(a);
  const right = labelPriority(b);
  if (left.scheduled_rank !== right.scheduled_rank) return left.scheduled_rank - right.scheduled_rank;
  if (left.scheduled_start !== right.scheduled_start) return left.scheduled_start.localeCompare(right.scheduled_start);
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.title.localeCompare(right.title);
}

function disambiguateLabels(rows) {
  const counts = new Map();
  const labels = [];
  for (const row of rows) {
    const base = compactTaskLabel(row);
    const next = (counts.get(base) || 0) + 1;
    counts.set(base, next);
    labels.push(next === 1 ? base : `${base} (${next})`);
  }
  return labels;
}

export function eodPollCandidates(date) {
  return mirrorRows("tasks")
    .filter((task) => task.archived !== true)
    .filter((task) => isActiveTask(task))
    .filter((task) => task.properties[TASK_FIELDS.horizon] === "today")
    .filter((task) => task.properties[TASK_FIELDS.stage] !== "blocked")
    .filter((task) => includeInHumanSummary(task))
    .filter((task) => !isAutoCompleteWhenScheduledTask(task))
    .sort(compareCandidates);
}

function buildPollBatches(date, tasks, { maxOptions = MAX_TELEGRAM_POLL_OPTIONS } = {}) {
  const runId = generatePollRunId(date);
  const labels = disambiguateLabels(tasks);
  const rows = tasks.map((task, index) => ({
    page_id: task.id,
    title: task.title,
    compact_label: labels[index],
    repeat_mode: repeatModeOf(task),
    scheduled_start: dateStart(task.properties[TASK_FIELDS.scheduledStart]),
    scheduled_end: dateStart(task.properties[TASK_FIELDS.scheduledEnd]),
    priority: task.properties[TASK_FIELDS.priority] || null
  }));

  const polls = [];
  for (let offset = 0; offset < rows.length; offset += maxOptions) {
    const slice = rows.slice(offset, offset + maxOptions);
    const batchIndex = polls.length;
    const batchId = generateBatchId(runId, batchIndex);
    polls.push({
      batch_id: batchId,
      batch_index: batchIndex,
      question: rows.length > maxOptions
        ? `What did you finish today? (${batchIndex + 1}/${Math.ceil(rows.length / maxOptions)})`
        : "What did you finish today?",
      options: slice.map((row, index) => ({
        index,
        ...row
      }))
    });
  }

  return {
    ok: true,
    action: "build-eod-poll",
    date,
    run_id: runId,
    count: rows.length,
    polls
  };
}

function nowIso() {
  return new Date().toISOString();
}

function parseSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function earliestEvent(events) {
  return [...events]
    .filter((row) => row.recorded_at)
    .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at))[0] || null;
}

function latestEvent(events) {
  return [...events]
    .filter((row) => row.recorded_at)
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))[0] || null;
}

function selectedIndexesFromPollResult(poll) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  return options
    .map((option, index) => ({ index, voters: Number(option.voter_count || 0) }))
    .filter((entry) => entry.voters > 0)
    .map((entry) => entry.index);
}

function buildApplySummary(state, selectedIndexes) {
  const selected = new Set(selectedIndexes);
  const selectedOptions = state.options.filter((option) => selected.has(option.index));
  const unselectedOptions = state.options.filter((option) => !selected.has(option.index));
  return {
    selected_page_ids: selectedOptions.map((option) => option.page_id),
    unselected_page_ids: unselectedOptions.map((option) => option.page_id),
    selected_labels: selectedOptions.map((option) => option.label),
    unselected_labels: unselectedOptions.map((option) => option.label)
  };
}

function applyDoneOutcome(task, date) {
  const cadence = task.properties[TASK_FIELDS.cadence];
  const repeatMode = repeatModeOf(task);
  const repeatTargetCount = Number(task.properties[TASK_FIELDS.repeatTargetCount] || 0);
  const repeatProgress = Number(task.properties[TASK_FIELDS.repeatProgress] || 0);

  if (repeatMode === "cadence" && cadence && cadence !== "none") {
    deleteCalendarRefs(task);
    const next = plusCadence(date, cadence);
    logCompletion(task, {
      completed_at: date,
      mode: "eod-poll-recurring-roll-forward",
      next_due: next,
      source: "eod-poll"
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
    return { page_id: task.id, task: task.title, mode: "recurring-roll-forward", next_due: next };
  }

  if (repeatMode === "manual_repeat") {
    deleteCalendarRefs(task);
    if (repeatTargetCount > 0) {
      const nextProgress = Math.min(repeatTargetCount, repeatProgress + 1);
      const reachedTarget = nextProgress >= repeatTargetCount;
      logCompletion(task, {
        completed_at: date,
        mode: reachedTarget ? "eod-poll-manual-repeat-window-complete" : "eod-poll-manual-repeat-progress",
        source: "eod-poll",
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
      return {
        page_id: task.id,
        task: task.title,
        mode: reachedTarget ? "manual-repeat-window-complete" : "manual-repeat-progress",
        progress: nextProgress,
        target: repeatTargetCount
      };
    }

    logCompletion(task, {
      completed_at: date,
      mode: "eod-poll-manual-repeat-done",
      source: "eod-poll"
    });
    updatePageProperties(task.id, {
      [TASK_FIELDS.status]: selectProperty("done"),
      [TASK_FIELDS.stage]: selectProperty("done"),
      [TASK_FIELDS.lastCompletedAt]: dateProperty(date),
      [TASK_FIELDS.nextDueAt]: dateProperty(null),
      ...clearCalendarProperties()
    });
    return { page_id: task.id, task: task.title, mode: "manual-repeat-done" };
  }

  logCompletion(task, {
    completed_at: date,
    mode: "eod-poll-archived",
    source: "eod-poll"
  });
  deleteCalendarRefs(task);
  archivePage(task.id);
  return { page_id: task.id, task: task.title, mode: "archived" };
}

function applyUncheckedOutcome(task, carryTo) {
  const nextMissCount = Number(task.properties[TASK_FIELDS.missCount] || 0) + 1;
  const hadCalendarState =
    Boolean(dateStart(task.properties[TASK_FIELDS.scheduledStart])) ||
    Boolean(dateStart(task.properties[TASK_FIELDS.scheduledEnd])) ||
    calendarRefsOf(task).length > 0;
  if (hadCalendarState) deleteCalendarRefs(task);
  updatePageProperties(task.id, carryForwardProperties(carryTo, nextMissCount));
  return {
    page_id: task.id,
    task: task.title,
    mode: "carried-forward",
    carry_to: carryTo,
    miss_count: nextMissCount,
    cleared_calendar_state: hadCalendarState
  };
}

function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function cmdListEodPollCandidates(args) {
  const date = normalizeDateArg(args.date);
  const rows = eodPollCandidates(date).map((task) => ({
    page_id: task.id,
    title: task.title,
    compact_label: compactTaskLabel(task),
    scheduled_start: dateStart(task.properties[TASK_FIELDS.scheduledStart]),
    scheduled_end: dateStart(task.properties[TASK_FIELDS.scheduledEnd]),
    repeat_mode: repeatModeOf(task),
    priority: task.properties[TASK_FIELDS.priority] || null
  }));
  emitJson({
    ok: true,
    action: "list-eod-poll-candidates",
    date,
    count: rows.length,
    rows
  });
}

export function cmdBuildEodPoll(args) {
  const date = normalizeDateArg(args.date);
  emitJson(buildPollBatches(date, eodPollCandidates(date)));
}

export async function cmdSendEodPoll(args) {
  const date = normalizeDateArg(args.date);
  const accountId = normalizeAccountId(args.account || TELEGRAM_POLL_ACCOUNT);
  const chatId = String(args.target || TELEGRAM_POLL_TARGET);
  const closeAfterSeconds = parseSeconds(args["close-after-seconds"], 60);
  const expireAfterSeconds = parseSeconds(args["expire-after-seconds"], 43200);
  const build = buildPollBatches(date, eodPollCandidates(date));

  if (build.count === 0) {
    emitJson({
      ok: true,
      action: "send-eod-poll",
      date,
      status: "skipped_no_candidates",
      count: 0
    });
    return;
  }

  const sent = [];
  for (const poll of build.polls) {
    const optionLabels = poll.options.map((option) => option.compact_label);
    const sentPoll = args["dry-run"] === true
      ? {
          chat_id: chatId,
          message_id: `dry-run-${poll.batch_index + 1}`,
          poll_id: `dry-run-${poll.batch_id}`
        }
      : await sendTelegramPoll({
          accountId,
          chatId,
          question: poll.question,
          options: optionLabels,
          allowsMultipleAnswers: true,
          isAnonymous: false
        });

    const state = {
      version: 1,
      status: "sent",
      sent_at: nowIso(),
      date,
      run_id: build.run_id,
      batch_id: poll.batch_id,
      batch_index: poll.batch_index,
      account_id: accountId,
      chat_id: sentPoll.chat_id,
      message_id: sentPoll.message_id,
      poll_id: sentPoll.poll_id,
      question: poll.question,
      options: poll.options.map((option, index) => ({
        index,
        page_id: option.page_id,
        title: option.title,
        label: option.compact_label,
        repeat_mode: option.repeat_mode,
        scheduled_start: option.scheduled_start,
        scheduled_end: option.scheduled_end
      })),
      close_after_seconds: closeAfterSeconds,
      expire_after_seconds: expireAfterSeconds,
      first_interaction_at: null,
      close_at: null,
      latest_answer_at: null,
      latest_selected_indexes: [],
      latest_selected_labels: [],
      latest_selected_page_ids: [],
      poll_result: null,
      apply_result: null
    };
    writePollState(state);
    sent.push({
      batch_id: state.batch_id,
      poll_id: state.poll_id,
      message_id: state.message_id,
      count: state.options.length,
      labels: state.options.map((option) => option.label)
    });
  }

  emitJson({
    ok: true,
    action: "send-eod-poll",
    date,
    run_id: build.run_id,
    count: build.count,
    polls_sent: sent.length,
    sent
  });
}

export function cmdApplyEodPollResults(args) {
  const date = normalizeDateArg(args.date);
  const carryTo = args["carry-to"] || "this week";
  const selectedPageIds = new Set(parseIdList(args["selected-page-ids"]));
  const unselectedPageIds = new Set(parseIdList(args["unselected-page-ids"]));
  const selectedApplied = [];
  const unselectedApplied = [];
  const skipped = [];

  for (const pageId of selectedPageIds) {
    const task = getPage(pageId);
    if (task.archived === true || isDoneTask(task)) {
      skipped.push({ page_id: pageId, task: task.title, reason: "already-done" });
      continue;
    }
    selectedApplied.push(applyDoneOutcome(task, date));
  }

  for (const pageId of unselectedPageIds) {
    const task = getPage(pageId);
    if (task.archived === true || isDoneTask(task)) {
      skipped.push({ page_id: pageId, task: task.title, reason: "already-done" });
      continue;
    }
    unselectedApplied.push(applyUncheckedOutcome(task, carryTo));
  }

  emitJson({
    ok: true,
    action: "apply-eod-poll-results",
    date,
    carry_to: carryTo,
    selected_applied: selectedApplied,
    unselected_applied: unselectedApplied,
    skipped
  });
}

function refreshStateFromAnswerLog(state) {
  const events = readPollAnswerEvents(state.account_id).filter((event) => event.poll_id === state.poll_id);
  if (events.length === 0) return state;
  const first = earliestEvent(events);
  const latest = latestEvent(events);
  if (!latest) return state;
  const firstInteractionAt = state.first_interaction_at || first?.recorded_at || null;
  const closeAt = firstInteractionAt
    ? new Date(Date.parse(firstInteractionAt) + state.close_after_seconds * 1000).toISOString()
    : state.close_at;
  const latestIndexes = latest.option_ids || [];
  const latestSelection = buildApplySummary(state, latestIndexes);
  return {
    ...state,
    status: "active",
    first_interaction_at: firstInteractionAt,
    close_at: closeAt,
    latest_answer_at: latest.recorded_at || null,
    latest_selected_indexes: latestIndexes,
    latest_selected_labels: latestSelection.selected_labels,
    latest_selected_page_ids: latestSelection.selected_page_ids
  };
}

async function closeAndApplyState(
  state,
  { carryTo = "this week", now = nowIso(), applyMutations = true } = {}
) {
  let finalPoll = state.poll_result;
  const isDryRun = String(state.poll_id || "").startsWith("dry-run-") || String(state.message_id || "").startsWith("dry-run-");
  if (!isDryRun) {
    try {
      finalPoll = await stopTelegramPoll({
        accountId: state.account_id,
        chatId: state.chat_id,
        messageId: state.message_id
      });
    } catch (error) {
      if (!state.latest_selected_indexes?.length && !/poll/i.test(String(error))) throw error;
    }
  }

  const selectedIndexes = finalPoll
    ? selectedIndexesFromPollResult(finalPoll)
    : state.latest_selected_indexes || [];
  const summary = !state.first_interaction_at && selectedIndexes.length === 0
    ? {
        selected_page_ids: [],
        unselected_page_ids: [],
        selected_labels: [],
        unselected_labels: []
      }
    : buildApplySummary(state, selectedIndexes);

  let applyResult = null;
  if (!applyMutations) {
    applyResult = {
      preview_only: true,
      selected_page_ids: summary.selected_page_ids,
      unselected_page_ids: summary.unselected_page_ids,
      selected_labels: summary.selected_labels,
      unselected_labels: summary.unselected_labels
    };
  } else if (summary.selected_page_ids.length > 0 || summary.unselected_page_ids.length > 0) {
    const selectedApplied = [];
    const unselectedApplied = [];
    const skipped = [];

    for (const pageId of summary.selected_page_ids) {
      const task = getPage(pageId);
      if (task.archived === true || isDoneTask(task)) {
        skipped.push({ page_id: pageId, task: task.title, reason: "already-done" });
        continue;
      }
      selectedApplied.push(applyDoneOutcome(task, state.date));
    }

    for (const pageId of summary.unselected_page_ids) {
      const task = getPage(pageId);
      if (task.archived === true || isDoneTask(task)) {
        skipped.push({ page_id: pageId, task: task.title, reason: "already-done" });
        continue;
      }
      unselectedApplied.push(applyUncheckedOutcome(task, carryTo));
    }

    applyResult = {
      selected_applied: selectedApplied,
      unselected_applied: unselectedApplied,
      skipped
    };
  }

  const nextState = {
    ...state,
    status: summary.selected_page_ids.length > 0 || summary.unselected_page_ids.length > 0
      ? (applyMutations ? "applied" : "ready_to_apply")
      : "expired_unanswered",
    closed_at: now,
    mutation_mode: applyMutations ? "apply" : "preview",
    poll_result: finalPoll || null,
    selected_indexes: selectedIndexes,
    ...summary,
    apply_result: applyResult
  };
  writePollState(nextState);
  return nextState;
}

export async function cmdProcessEodPolls(args) {
  const now = args.now || nowIso();
  const carryTo = args["carry-to"] || "this week";
  const applyMutations = args["no-apply"] !== true;
  const batchId = args["batch-id"] || null;
  const states = batchId
    ? [readPollState(batchId)]
    : listPollStates({}).filter((state) => ["sent", "active"].includes(state.status));

  const processed = [];
  for (const rawState of states) {
    let state = refreshStateFromAnswerLog(rawState);
    const sentTs = Date.parse(state.sent_at || "");
    const closeTs = Date.parse(state.close_at || "");
    const expireTs =
      Number.isFinite(sentTs) && Number.isFinite(state.expire_after_seconds)
        ? sentTs + state.expire_after_seconds * 1000
        : null;

    if (state.first_interaction_at && Number.isFinite(closeTs) && Date.parse(now) >= closeTs) {
      state = await closeAndApplyState(state, { carryTo, now, applyMutations });
      processed.push({
        batch_id: state.batch_id,
        mutation_mode: state.mutation_mode || (applyMutations ? "apply" : "preview"),
        status: state.status,
        selected_page_ids: state.selected_page_ids || [],
        unselected_page_ids: state.unselected_page_ids || []
      });
      continue;
    }

    if (!state.first_interaction_at && expireTs !== null && Date.parse(now) >= expireTs) {
      state = await closeAndApplyState(state, { carryTo, now, applyMutations });
      processed.push({
        batch_id: state.batch_id,
        mutation_mode: state.mutation_mode || (applyMutations ? "apply" : "preview"),
        status: state.status,
        selected_page_ids: state.selected_page_ids || [],
        unselected_page_ids: state.unselected_page_ids || []
      });
      continue;
    }

    writePollState(state);
    processed.push({
      batch_id: state.batch_id,
      status: state.status,
      first_interaction_at: state.first_interaction_at,
      close_at: state.close_at
    });
  }

  emitJson({
    ok: true,
    action: "process-eod-polls",
    mutation_mode: applyMutations ? "apply" : "preview",
    count: processed.length,
    processed
  });
}
