import fs from "node:fs";
import path from "node:path";

import {
  OPENCLAW_CONTAINER_ROOT,
  OPENCLAW_HOST_ROOT,
  POLL_STATE_ROOT,
  TELEGRAM_POLL_ACCOUNT
} from "./config.mjs";
import { readJsonLines, resolveRuntimePath } from "./util.mjs";

export const TELEGRAM_POLL_ANSWER_DIR =
  process.env.TELEGRAM_POLL_ANSWER_DIR || "/data/.openclaw/telegram";
export const MAX_TELEGRAM_POLL_OPTIONS = 10;

function translateOpenClawPath(filePath, fromRoot, toRoot) {
  if (!filePath || !fromRoot || !toRoot) return null;
  if (!filePath.startsWith(fromRoot)) return null;
  return `${toRoot}${filePath.slice(fromRoot.length)}`;
}

function resolvePollPath(filePath) {
  if (fs.existsSync(OPENCLAW_CONTAINER_ROOT)) {
    return translateOpenClawPath(filePath, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT) || filePath;
  }
  if (fs.existsSync(OPENCLAW_HOST_ROOT)) {
    return translateOpenClawPath(filePath, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT) || filePath;
  }
  return resolveRuntimePath(filePath, [
    translateOpenClawPath(filePath, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
    translateOpenClawPath(filePath, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
  ]);
}

export function pollStateRoot() {
  return resolvePollPath(POLL_STATE_ROOT);
}

export function answerLogPath(accountId = TELEGRAM_POLL_ACCOUNT) {
  return resolvePollPath(`${TELEGRAM_POLL_ANSWER_DIR}/poll-answers-${accountId}.jsonl`);
}

export function normalizeAccountId(accountId) {
  return String(accountId || TELEGRAM_POLL_ACCOUNT).trim() || TELEGRAM_POLL_ACCOUNT;
}

export function batchStatePath(batchId) {
  return path.join(pollStateRoot(), `${batchId}.json`);
}

export function generatePollRunId(date) {
  return `eod-${date}-${Date.now()}`;
}

export function generateBatchId(runId, index) {
  return `${runId}-batch-${String(index + 1).padStart(2, "0")}`;
}

export function ensurePollStateDir() {
  fs.mkdirSync(pollStateRoot(), { recursive: true });
}

export function writePollState(state) {
  ensurePollStateDir();
  const filePath = batchStatePath(state.batch_id);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return filePath;
}

export function readPollStateByPath(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readPollState(batchId) {
  return readPollStateByPath(batchStatePath(batchId));
}

export function listPollStateFiles() {
  const root = pollStateRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(root, name))
    .sort();
}

export function listPollStates({ status } = {}) {
  return listPollStateFiles()
    .map((filePath) => readPollStateByPath(filePath))
    .filter((state) => (status ? state.status === status : true));
}

export function readPollAnswerEvents(accountId = TELEGRAM_POLL_ACCOUNT) {
  return readJsonLines(answerLogPath(accountId))
    .map((row) => ({
      ...row,
      recorded_at: row.recorded_at || null,
      poll_id: row.poll_id || null,
      option_ids: Array.isArray(row.option_ids) ? row.option_ids.map((value) => Number(value)) : []
    }))
    .filter((row) => row.poll_id);
}
