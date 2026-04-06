import { TELEGRAM_POLL_ACCOUNT, TELEGRAM_POLL_TARGET } from "./config.mjs";
import {
  listTelegramPollMetadata,
  normalizeAccountId,
  releaseLock,
  readLatestTelegramPollMetadata,
  readPollAnswerEvents,
  readTelegramPollMetadata,
  tryAcquireTelegramPollLock,
  writeTelegramPollMetadata
} from "./polls.mjs";
import { sendTelegramMessage, sendTelegramPoll, stopTelegramPoll } from "./telegram.mjs";

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function parseArgsList(value) {
  return String(value || "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1" || value === "yes") return true;
  if (value === false || value === "false" || value === "0" || value === "no") return false;
  throw new Error(`invalid boolean: ${value}`);
}

function latestByPollId(accountId, pollId) {
  const matches = readPollAnswerEvents(accountId)
    .filter((row) => row.poll_id === pollId)
    .sort((a, b) => String(b.recorded_at || "").localeCompare(String(a.recorded_at || "")));
  return matches[0] || null;
}

function selectedLabels(metadata, answer) {
  const optionIds = Array.isArray(answer?.option_ids) ? answer.option_ids.map((value) => Number(value)) : [];
  return optionIds
    .filter((value) => Number.isInteger(value) && value >= 0 && value < metadata.options.length)
    .map((value) => metadata.options[value]);
}

function normalizeOptionIds(optionIds) {
  return Array.from(
    new Set(
      (Array.isArray(optionIds) ? optionIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
    )
  ).sort((a, b) => a - b);
}

function selectionSummary(metadata, answer) {
  const optionIds = normalizeOptionIds(answer?.option_ids);
  return {
    poll_id: metadata.poll_id,
    question: metadata.question,
    account_id: metadata.account_id,
    chat_id: metadata.chat_id,
    message_id: metadata.message_id,
    options: metadata.options,
    answer_recorded_at: answer?.recorded_at || null,
    option_ids: optionIds,
    selected_labels: selectedLabels(metadata, answer)
  };
}

function notificationText(summary) {
  if ((summary.selected_labels || []).length === 0) {
    return "You cleared all poll options.";
  }
  return `You picked:\n${summary.selected_labels.map((label) => `• ${label}`).join("\n")}`;
}

function metadataForArgs(args) {
  const accountId = normalizeAccountId(args.account || TELEGRAM_POLL_ACCOUNT);
  const pollId = String(args["poll-id"] || "").trim();
  if (pollId) return readTelegramPollMetadata(pollId);
  return readLatestTelegramPollMetadata(accountId);
}

export async function cmdSendTelegramPoll(args) {
  const accountId = normalizeAccountId(args.account || TELEGRAM_POLL_ACCOUNT);
  const chatId = String(args.target || TELEGRAM_POLL_TARGET);
  const question = String(args.question || args._[0] || "").trim();
  const options = parseArgsList(args.options || args._.slice(1).join("|"));
  const allowsMultipleAnswers = parseBoolean(args.multiple, true) && !parseBoolean(args.single, false);
  const notifyOnAnswer = parseBoolean(args["notify-on-answer"], false);

  if (!question) throw new Error("missing poll question");
  if (options.length < 2) throw new Error("need at least two poll options");

  const sent = await sendTelegramPoll({
    accountId,
    chatId,
    question,
    options,
    allowsMultipleAnswers,
    isAnonymous: false
  });

  const metadata = {
    version: 1,
    kind: "telegram_poll",
    poll_id: sent.poll_id,
    account_id: accountId,
    chat_id: sent.chat_id,
    message_id: sent.message_id,
    question,
    options,
    allows_multiple_answers: allowsMultipleAnswers,
    notify_on_answer: notifyOnAnswer,
    sent_at: new Date().toISOString(),
    last_notified_at: null,
    last_notified_option_ids: []
  };
  try {
    writeTelegramPollMetadata(metadata);
  } catch (error) {
    await stopTelegramPoll({
      accountId,
      chatId: sent.chat_id,
      messageId: sent.message_id
    }).catch(() => null);
    throw error;
  }
  emitJson({ ok: true, action: "send-telegram-poll", ...metadata });
}

export function cmdReadTelegramPoll(args) {
  const metadata = metadataForArgs(args);
  const answer = latestByPollId(metadata.account_id, metadata.poll_id);
  emitJson({
    ok: true,
    action: "read-telegram-poll",
    ...selectionSummary(metadata, answer)
  });
}

export async function cmdProcessTelegramPollReplies(args) {
  const accountId = normalizeAccountId(args.account || TELEGRAM_POLL_ACCOUNT);
  const onlyPollId = String(args["poll-id"] || "").trim() || null;
  const metadataRows = (onlyPollId ? [readTelegramPollMetadata(onlyPollId)] : listTelegramPollMetadata())
    .filter((row) => row.kind === "telegram_poll")
    .filter((row) => row.account_id === accountId)
    .filter((row) => row.notify_on_answer === true);

  const processed = [];
  for (const metadata of metadataRows) {
    const lockPath = tryAcquireTelegramPollLock(metadata.poll_id);
    if (!lockPath) {
      processed.push({ poll_id: metadata.poll_id, status: "locked" });
      continue;
    }
    try {
      const answer = latestByPollId(metadata.account_id, metadata.poll_id);
      if (!answer) {
        processed.push({ poll_id: metadata.poll_id, status: "pending_answer" });
        continue;
      }
      const optionIds = normalizeOptionIds(answer.option_ids);
      const prior = normalizeOptionIds(metadata.last_notified_option_ids);
      const unchanged =
        optionIds.length === prior.length &&
        optionIds.every((value, index) => value === prior[index]);
      if (unchanged) {
        processed.push({ poll_id: metadata.poll_id, status: "already_notified", option_ids: optionIds });
        continue;
      }

      const summary = selectionSummary(metadata, answer);
      await sendTelegramMessage({
        accountId: metadata.account_id,
        chatId: metadata.chat_id,
        text: notificationText(summary)
      });

      const nextMetadata = {
        ...metadata,
        last_notified_at: new Date().toISOString(),
        last_notified_option_ids: optionIds
      };
      writeTelegramPollMetadata(nextMetadata);

      processed.push({
        poll_id: metadata.poll_id,
        status: "notified",
        option_ids: optionIds,
        selected_labels: summary.selected_labels
      });
    } catch (error) {
      processed.push({
        poll_id: metadata.poll_id,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      releaseLock(lockPath);
    }
  }

  emitJson({
    ok: true,
    action: "process-telegram-poll-replies",
    count: processed.length,
    processed
  });
}
