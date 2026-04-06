import { TASK_FIELDS, TELEGRAM_POLL_ACCOUNT, TELEGRAM_POLL_TARGET } from "./config.mjs";
import { deleteCalendarEvent } from "./calendar.mjs";
import { dateStart, logCompletion } from "./history.mjs";
import { compactTaskLabel, includeInHumanSummary } from "./human-summary.mjs";
import { archivePage, getPage, queryDataSourceRows, updatePageProperties } from "./notion.mjs";
import {
  MAX_TELEGRAM_POLL_OPTIONS,
  generateBatchId,
  generatePollRunId,
  listPollStates,
  normalizeAccountId,
  releaseLock,
  readPollAnswerEvents,
  readPollState,
  tryAcquireBatchLock,
  writePollState
} from "./polls.mjs";
import { sendTelegramMessage, sendTelegramPoll, stopTelegramPoll } from "./telegram.mjs";
import {
  board,
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
  repeatModeOf,
  scheduledTouchesDate
} from "./tasks.mjs";
import { dateProperty, normalizeDateArg, numberProperty, selectProperty, sleep } from "./util.mjs";

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
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

function isEodRelevantTask(task, date) {
  if (task.archived === true) return false;
  if (!isActiveTask(task)) return false;
  if (task.properties[TASK_FIELDS.stage] === "blocked") return false;
  if (!includeInHumanSummary(task)) return false;
  if (isAutoCompleteWhenScheduledTask(task)) return false;

  const horizon = task.properties[TASK_FIELDS.horizon];
  const dueDate = dateStart(task.properties[TASK_FIELDS.dueDate]);
  if (horizon === "today") return true;
  if (dueDate === date) return true;
  if (scheduledTouchesDate(task, date)) return true;
  return false;
}

function freshTaskRows() {
  const dataSourceId = board().databases?.tasks?.data_source_id || null;
  return dataSourceId ? queryDataSourceRows(dataSourceId) : mirrorRows("tasks");
}

export function eodPollCandidates(date) {
  return freshTaskRows()
    .filter((task) => isEodRelevantTask(task, date))
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

  if (rows.length === 1) {
    const [row] = rows;
    return {
      ok: true,
      action: "build-eod-poll",
      date,
      run_id: runId,
      count: 1,
      polls: [
        {
          batch_id: generateBatchId(runId, 0),
          batch_index: 0,
          kind: "single_task_list_fallback",
          allows_multiple_answers: false,
          question: "What did you finish today?",
          options: [
            {
              index: 0,
              ...row,
              compact_label: row.compact_label,
              task_label: row.compact_label,
              outcome: "selected"
            },
            {
              index: 1,
              page_id: null,
              title: "Nothing from this list",
              compact_label: "Nothing from this list",
              task_label: null,
              outcome: "none"
            }
          ]
        }
      ]
    };
  }

  const polls = [];
  for (let offset = 0; offset < rows.length; offset += maxOptions) {
    const slice = rows.slice(offset, offset + maxOptions);
    const batchIndex = polls.length;
    const batchId = generateBatchId(runId, batchIndex);
    polls.push({
      batch_id: batchId,
      batch_index: batchIndex,
      kind: "task_checklist",
      allows_multiple_answers: true,
      question: rows.length > maxOptions
        ? `What did you finish today? (${batchIndex + 1}/${Math.ceil(rows.length / maxOptions)})`
        : "What did you finish today?",
      options: slice.map((row, index) => ({
        index,
        ...row,
        task_label: row.compact_label,
        outcome: "selected"
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

function parseWatchSeconds(value, fallback = 180) {
  if (value === undefined || value === null || value === false) return 0;
  if (value === true || value === "true" || value === "yes") return fallback;
  if (value === "false" || value === "no" || value === "0") return 0;
  return parseSeconds(value, fallback);
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

function selectedIndexesForState(state, pollResult) {
  const pollSelected = pollResult ? selectedIndexesFromPollResult(pollResult) : [];
  if (pollSelected.length > 0) return pollSelected;
  if ((state.latest_selected_indexes || []).length > 0) return state.latest_selected_indexes || [];
  if (Number(pollResult?.total_voter_count || 0) > 0) return pollSelected;
  return state.latest_selected_indexes || [];
}

function buildApplySummary(state, selectedIndexes) {
  const selected = new Set(selectedIndexes);
  const optionLabel = (option) => option.task_label || option.label;
  const isSingleTaskListFallback = state.kind === "single_task_list_fallback";
  const actualOptions = state.options.filter((option) => option.page_id);
  const selectedOptions = isSingleTaskListFallback
    ? actualOptions.filter((option) => selected.has(option.index) && option.outcome === "selected")
    : actualOptions.filter((option) => selected.has(option.index));
  const unselectedOptions = isSingleTaskListFallback
    ? (selectedOptions.length > 0 ? [] : actualOptions)
    : actualOptions.filter((option) => !selected.has(option.index));
  return {
    selected_page_ids: selectedOptions.map((option) => option.page_id),
    unselected_page_ids: unselectedOptions.map((option) => option.page_id),
    selected_labels: selectedOptions.map(optionLabel),
    unselected_labels: unselectedOptions.map(optionLabel)
  };
}

function eodFollowUpText(state) {
  const done = Array.isArray(state.selected_labels) ? state.selected_labels : [];
  const missed = Array.isArray(state.unselected_labels) ? state.unselected_labels : [];
  const lines = [];

  if (done.length > 0) {
    lines.push("Recorded from your poll:", "");
    for (const label of done) {
      lines.push(`• ${label}`);
    }
  }

  if (missed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Unchecked / missed:", "");
    for (const label of missed) {
      lines.push(`• ${label}`);
    }
    lines.push("");
    lines.push("I carried the unchecked ones forward. Do you want me to reschedule any of them for tomorrow?");
  } else if (done.length > 0) {
    lines.push("", "Everything in this poll is now recorded as done.");
  }

  return lines.join("\n").trim();
}

function shouldSendFollowUp(state) {
  if (!state || state.follow_up_sent_at || !state.first_interaction_at) return false;
  const doneCount = Array.isArray(state.selected_labels) ? state.selected_labels.length : 0;
  const missedCount = Array.isArray(state.unselected_labels) ? state.unselected_labels.length : 0;
  return doneCount > 0 || missedCount > 0;
}

function summarizeState(state) {
  return {
    batch_id: state.batch_id,
    status: state.status,
    poll_id: state.poll_id,
    first_interaction_at: state.first_interaction_at || null,
    close_at: state.close_at || null,
    selected_page_ids: state.selected_page_ids || [],
    unselected_page_ids: state.unselected_page_ids || [],
    follow_up_sent_at: state.follow_up_sent_at || null,
    follow_up_message_id: state.follow_up_message_id || null,
    follow_up_failed_at: state.follow_up_failed_at || null,
    follow_up_error: state.follow_up_error || null
  };
}

function isResolvedForWatch(state, applyMutations) {
  if (!["applied", "ready_to_apply", "expired_unanswered"].includes(state.status)) return false;
  if (!applyMutations) return true;
  if (state.status === "expired_unanswered") return true;
  if (!shouldSendFollowUp(state)) return true;
  return Boolean(state.follow_up_sent_at);
}

async function maybeSendFollowUp(state, { now = nowIso() } = {}) {
  const isDryRun =
    String(state.poll_id || "").startsWith("dry-run-") ||
    String(state.message_id || "").startsWith("dry-run-");
  if (isDryRun || !shouldSendFollowUp(state)) return state;

  const followUp = eodFollowUpText(state);
  if (!followUp) return state;

  try {
    const sent = await sendTelegramMessage({
      accountId: state.account_id,
      chatId: state.chat_id,
      text: followUp
    });
    const notifiedState = {
      ...state,
      follow_up_sent_at: now,
      follow_up_message_id: sent.message_id,
      follow_up_chat_id: sent.chat_id,
      follow_up_failed_at: null,
      follow_up_error: null
    };
    writePollState(notifiedState);
    return notifiedState;
  } catch (error) {
    const failedState = {
      ...state,
      follow_up_failed_at: now,
      follow_up_error: String(error)
    };
    writePollState(failedState);
    return failedState;
  }
}

function applyDoneOutcome(task, date) {
  const cadence = task.properties[TASK_FIELDS.cadence];
  const repeatMode = repeatModeOf(task);
  const repeatTargetCount = Number(task.properties[TASK_FIELDS.repeatTargetCount] || 0);
  const repeatProgress = Number(task.properties[TASK_FIELDS.repeatProgress] || 0);

  if (repeatMode === "cadence" && cadence && cadence !== "none") {
    const refs = calendarRefSnapshot(task);
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
    deleteCalendarRefList(refs);
    return { page_id: task.id, task: task.title, mode: "recurring-roll-forward", next_due: next };
  }

  if (repeatMode === "manual_repeat") {
    const refs = calendarRefSnapshot(task);
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
      deleteCalendarRefList(refs);
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
    deleteCalendarRefList(refs);
    return { page_id: task.id, task: task.title, mode: "manual-repeat-done" };
  }

  logCompletion(task, {
    completed_at: date,
    mode: "eod-poll-archived",
    source: "eod-poll"
  });
  const refs = calendarRefSnapshot(task);
  updatePageProperties(task.id, {
    ...clearCalendarProperties()
  });
  archivePage(task.id);
  deleteCalendarRefList(refs);
  return { page_id: task.id, task: task.title, mode: "archived" };
}

function applyUncheckedOutcome(task, carryTo) {
  const nextMissCount = Number(task.properties[TASK_FIELDS.missCount] || 0) + 1;
  const hadCalendarState =
    Boolean(dateStart(task.properties[TASK_FIELDS.scheduledStart])) ||
    Boolean(dateStart(task.properties[TASK_FIELDS.scheduledEnd])) ||
    calendarRefsOf(task).length > 0;
  const refs = hadCalendarState ? calendarRefSnapshot(task) : [];
  updatePageProperties(task.id, carryForwardProperties(carryTo, nextMissCount));
  if (hadCalendarState) deleteCalendarRefList(refs);
  return {
    page_id: task.id,
    task: task.title,
    mode: "carried-forward",
    carry_to: carryTo,
    miss_count: nextMissCount,
    cleared_calendar_state: hadCalendarState
  };
}

function processedPageIds(applyResult) {
  const ids = new Set();
  for (const row of applyResult?.selected_applied || []) {
    if (row?.page_id) ids.add(row.page_id);
  }
  for (const row of applyResult?.unselected_applied || []) {
    if (row?.page_id) ids.add(row.page_id);
  }
  for (const row of applyResult?.skipped || []) {
    if (row?.page_id) ids.add(row.page_id);
  }
  return ids;
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
  const watchSeconds = parseWatchSeconds(args["watch-seconds"] ?? args.watch, 180);
  const watchIntervalSeconds = parseSeconds(args["watch-interval-seconds"], 2);
  const carryTo = args["carry-to"] || "this week";
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
  const batchIds = [];
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
          allowsMultipleAnswers: poll.allows_multiple_answers !== false,
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
      kind: poll.kind || "task_checklist",
      account_id: accountId,
      chat_id: sentPoll.chat_id,
      message_id: sentPoll.message_id,
      poll_id: sentPoll.poll_id,
      question: poll.question,
      options: poll.options.map((option, index) => ({
        index,
        page_id: option.page_id,
        title: option.title,
        label: option.task_label || option.compact_label,
        poll_label: option.compact_label,
        task_label: option.task_label || option.compact_label,
        outcome: option.outcome || "selected",
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
    try {
      writePollState(state);
    } catch (error) {
      if (args["dry-run"] !== true) {
        await stopTelegramPoll({
          accountId,
          chatId: sentPoll.chat_id,
          messageId: sentPoll.message_id
        }).catch(() => null);
      }
      throw error;
    }
    batchIds.push(state.batch_id);
    sent.push({
      batch_id: state.batch_id,
      poll_id: state.poll_id,
      message_id: state.message_id,
      count: state.options.length,
      labels: state.options.map((option) => option.label)
    });
  }

  const watch =
    watchSeconds > 0
      ? await waitForPollResolution(batchIds, {
          carryTo,
          watchSeconds,
          watchIntervalSeconds,
          applyMutations: true
        })
      : null;

  emitJson({
    ok: true,
    action: "send-eod-poll",
    date,
    run_id: build.run_id,
    count: build.count,
    polls_sent: sent.length,
    sent,
    ...(watch ? { watch } : {})
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
    status: ["sent", "active"].includes(state.status) ? "active" : state.status,
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

  const selectedIndexes = selectedIndexesForState(state, finalPoll);
  const summary = !state.first_interaction_at && selectedIndexes.length === 0
    ? {
        selected_page_ids: [],
        unselected_page_ids: [],
        selected_labels: [],
        unselected_labels: []
      }
    : buildApplySummary(state, selectedIndexes);

  let applyResult = state.apply_result || null;
  if (!applyMutations) {
    applyResult = {
      preview_only: true,
      selected_page_ids: summary.selected_page_ids,
      unselected_page_ids: summary.unselected_page_ids,
      selected_labels: summary.selected_labels,
      unselected_labels: summary.unselected_labels
    };
  } else if (summary.selected_page_ids.length > 0 || summary.unselected_page_ids.length > 0) {
    const selectedApplied = Array.isArray(applyResult?.selected_applied) ? [...applyResult.selected_applied] : [];
    const unselectedApplied = Array.isArray(applyResult?.unselected_applied) ? [...applyResult.unselected_applied] : [];
    const skipped = Array.isArray(applyResult?.skipped) ? [...applyResult.skipped] : [];
    const doneIds = processedPageIds({ selected_applied: selectedApplied, unselected_applied: unselectedApplied, skipped });

    const applyingState = {
      ...state,
      status: "applying",
      closed_at: now,
      mutation_mode: applyMutations ? "apply" : "preview",
      poll_result: finalPoll || null,
      selected_indexes: selectedIndexes,
      ...summary,
      apply_result: {
        selected_applied: selectedApplied,
        unselected_applied: unselectedApplied,
        skipped
      }
    };
    writePollState(applyingState);

    for (const pageId of summary.selected_page_ids) {
      if (doneIds.has(pageId)) continue;
      const task = getPage(pageId);
      if (task.archived === true || isDoneTask(task)) {
        skipped.push({ page_id: pageId, task: task.title, reason: "already-done" });
        doneIds.add(pageId);
        writePollState({
          ...applyingState,
          apply_result: {
            selected_applied: selectedApplied,
            unselected_applied: unselectedApplied,
            skipped
          }
        });
        continue;
      }
      selectedApplied.push(applyDoneOutcome(task, state.date));
      doneIds.add(pageId);
      writePollState({
        ...applyingState,
        apply_result: {
          selected_applied: selectedApplied,
          unselected_applied: unselectedApplied,
          skipped
        }
      });
    }

    for (const pageId of summary.unselected_page_ids) {
      if (doneIds.has(pageId)) continue;
      const task = getPage(pageId);
      if (task.archived === true || isDoneTask(task)) {
        skipped.push({ page_id: pageId, task: task.title, reason: "already-done" });
        doneIds.add(pageId);
        writePollState({
          ...applyingState,
          apply_result: {
            selected_applied: selectedApplied,
            unselected_applied: unselectedApplied,
            skipped
          }
        });
        continue;
      }
      unselectedApplied.push(applyUncheckedOutcome(task, carryTo));
      doneIds.add(pageId);
      writePollState({
        ...applyingState,
        apply_result: {
          selected_applied: selectedApplied,
          unselected_applied: unselectedApplied,
          skipped
        }
      });
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
  return applyMutations && !isDryRun
    ? maybeSendFollowUp(nextState, { now })
    : nextState;
}

async function processState(
  rawState,
  { carryTo = "this week", now = nowIso(), applyMutations = true } = {}
) {
  let state = refreshStateFromAnswerLog(rawState);
  const sentTs = Date.parse(state.sent_at || "");
  const closeTs = Date.parse(state.close_at || "");
  const expireTs =
    Number.isFinite(sentTs) && Number.isFinite(state.expire_after_seconds)
      ? sentTs + state.expire_after_seconds * 1000
      : null;

  if (state.status === "applied" && applyMutations && !state.follow_up_sent_at) {
    return maybeSendFollowUp(state, { now });
  }

  if (state.status === "applying") {
    return closeAndApplyState(state, { carryTo, now, applyMutations });
  }

  if (state.first_interaction_at && Number.isFinite(closeTs) && Date.parse(now) >= closeTs) {
    return closeAndApplyState(state, { carryTo, now, applyMutations });
  }

  if (!state.first_interaction_at && expireTs !== null && Date.parse(now) >= expireTs) {
    return closeAndApplyState(state, { carryTo, now, applyMutations });
  }

  writePollState(state);
  return state;
}

async function processStateSafely(
  rawState,
  { carryTo = "this week", now = nowIso(), applyMutations = true } = {}
) {
  const lockPath = tryAcquireBatchLock(rawState.batch_id);
  if (!lockPath) {
    return {
      ...rawState,
      lock_status: "busy"
    };
  }
  try {
    return await processState(rawState, { carryTo, now, applyMutations });
  } finally {
    releaseLock(lockPath);
  }
}

async function waitForPollResolution(
  batchIds,
  {
    carryTo = "this week",
    watchSeconds = 180,
    watchIntervalSeconds = 2,
    applyMutations = true
  } = {}
) {
  if (!Array.isArray(batchIds) || batchIds.length === 0 || watchSeconds <= 0) {
    return {
      status: "skipped",
      timed_out: false,
      count: 0,
      batches: []
    };
  }

  const deadline = Date.now() + watchSeconds * 1000;
  const pollIntervalMs = Math.max(1, watchIntervalSeconds) * 1000;

  while (Date.now() <= deadline) {
    const batches = [];
    for (const batchId of batchIds) {
      try {
        const state = await processStateSafely(readPollState(batchId), {
          carryTo,
          now: nowIso(),
          applyMutations
        });
        batches.push(summarizeState(state));
      } catch (error) {
        batches.push({
          batch_id: batchId,
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (batches.every((state) => isResolvedForWatch(state, applyMutations))) {
      return {
        status: "resolved",
        timed_out: false,
        count: batches.length,
        batches
      };
    }

    sleep(pollIntervalMs);
  }

  const batches = batchIds.map((batchId) => summarizeState(readPollState(batchId)));
  return {
    status: "timeout",
    timed_out: true,
    count: batches.length,
    batches
  };
}

export async function cmdProcessEodPolls(args) {
  const now = args.now || nowIso();
  const carryTo = args["carry-to"] || "this week";
  const applyMutations = args["no-apply"] !== true;
  const batchId = args["batch-id"] || null;
  const states = batchId
    ? [readPollState(batchId)]
    : listPollStates({}).filter((state) =>
        ["sent", "active", "applying"].includes(state.status) ||
        (state.status === "applied" && !state.follow_up_sent_at)
      );

  const processed = [];
  for (const rawState of states) {
    try {
      const state = await processStateSafely(rawState, { carryTo, now, applyMutations });
      processed.push({
        ...summarizeState(state),
        lock_status: state.lock_status || null,
        mutation_mode: state.mutation_mode || (applyMutations ? "apply" : "preview")
      });
    } catch (error) {
      processed.push({
        batch_id: rawState.batch_id,
        status: "error",
        mutation_mode: applyMutations ? "apply" : "preview",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  emitJson({
    ok: true,
    action: "process-eod-polls",
    mutation_mode: applyMutations ? "apply" : "preview",
    count: processed.length,
    processed
  });
}
