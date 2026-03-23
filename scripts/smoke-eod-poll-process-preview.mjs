#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeJsonLine(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-eod-poll-preview-"));
const historyRoot = path.join(root, "history");
const pollStateRoot = path.join(historyRoot, "polls");
const telegramRoot = path.join(root, "telegram");
const answeredBatchId = "eod-2099-01-01-123456-batch-01";
const unansweredBatchId = "eod-2099-01-01-123456-batch-02";

writeJson(path.join(pollStateRoot, `${answeredBatchId}.json`), {
  version: 1,
  status: "sent",
  sent_at: "2099-01-01T21:35:00.000Z",
  date: "2099-01-01",
  run_id: "eod-2099-01-01-123456",
  batch_id: answeredBatchId,
  batch_index: 0,
  account_id: "bot4",
  chat_id: "492482728",
  message_id: "dry-run-1",
  poll_id: "dry-run-poll-1",
  question: "What did you finish today?",
  options: [
    { index: 0, page_id: "page-1", title: "Workout plan", label: "workout plan" },
    { index: 1, page_id: "page-2", title: "Pick up post", label: "pick up post" },
    { index: 2, page_id: "page-3", title: "Define Notion", label: "define Notion" }
  ],
  close_after_seconds: 60,
  expire_after_seconds: 43200,
  first_interaction_at: null,
  close_at: null,
  latest_answer_at: null,
  latest_selected_indexes: [],
  latest_selected_labels: [],
  latest_selected_page_ids: [],
  poll_result: null,
  apply_result: null
});

writeJson(path.join(pollStateRoot, `${unansweredBatchId}.json`), {
  version: 1,
  status: "sent",
  sent_at: "2099-01-01T21:35:00.000Z",
  date: "2099-01-01",
  run_id: "eod-2099-01-01-123456",
  batch_id: unansweredBatchId,
  batch_index: 1,
  account_id: "bot4",
  chat_id: "492482728",
  message_id: "dry-run-2",
  poll_id: "dry-run-poll-2",
  question: "What did you finish today? (2/2)",
  options: [
    { index: 0, page_id: "page-4", title: "Read a book", label: "read a book" },
    { index: 1, page_id: "page-5", title: "Do dishes", label: "do dishes" }
  ],
  close_after_seconds: 60,
  expire_after_seconds: 43200,
  first_interaction_at: null,
  close_at: null,
  latest_answer_at: null,
  latest_selected_indexes: [],
  latest_selected_labels: [],
  latest_selected_page_ids: [],
  poll_result: null,
  apply_result: null
});

writeJsonLine(path.join(telegramRoot, "poll-answers-bot4.jsonl"), {
  recorded_at: "2099-01-01T21:36:05.000Z",
  account_id: "bot4",
  poll_id: "dry-run-poll-1",
  user_id: "492482728",
  option_ids: [0, 2],
  update_id: 1
});

const output = execFileSync("node", [
  "./notion-board-ops.mjs",
  "process-eod-polls",
  "--no-apply",
  "--now",
  "2099-01-02T12:00:00.000Z"
], {
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  encoding: "utf8",
  env: {
    ...process.env,
    HISTORY_ROOT: historyRoot,
    TELEGRAM_POLL_ANSWER_DIR: telegramRoot
  }
});

const result = JSON.parse(output);
const processed = new Map((result.processed || []).map((row) => [row.batch_id, row]));
const answered = processed.get(answeredBatchId);
const unanswered = processed.get(unansweredBatchId);

if (result.ok !== true) {
  throw new Error(`preview process did not succeed: ${output}`);
}
if (result.mutation_mode !== "preview") {
  throw new Error(`expected preview mutation mode, got: ${result.mutation_mode}`);
}
if (answered?.status !== "ready_to_apply") {
  throw new Error(`expected answered batch to be ready_to_apply, got: ${answered?.status}`);
}
if (JSON.stringify(answered.selected_page_ids) !== JSON.stringify(["page-1", "page-3"])) {
  throw new Error(`unexpected selected_page_ids: ${JSON.stringify(answered?.selected_page_ids)}`);
}
if (JSON.stringify(answered.unselected_page_ids) !== JSON.stringify(["page-2"])) {
  throw new Error(`unexpected unselected_page_ids: ${JSON.stringify(answered?.unselected_page_ids)}`);
}
if (unanswered?.status !== "expired_unanswered") {
  throw new Error(`expected unanswered batch to expire unanswered, got: ${unanswered?.status}`);
}
if (JSON.stringify(unanswered.selected_page_ids) !== JSON.stringify([])) {
  throw new Error(`unexpected unanswered selected_page_ids: ${JSON.stringify(unanswered?.selected_page_ids)}`);
}
if (JSON.stringify(unanswered.unselected_page_ids) !== JSON.stringify([])) {
  throw new Error(`unexpected unanswered unselected_page_ids: ${JSON.stringify(unanswered?.unselected_page_ids)}`);
}

console.log(JSON.stringify({
  ok: true,
  action: "smoke-eod-poll-process-preview",
  root,
  result
}, null, 2));
