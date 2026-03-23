import { execFileSync } from "node:child_process";
import fs from "node:fs";

import {
  CONTAINER,
  OPENCLAW_CONTAINER_ROOT,
  OPENCLAW_HOST_ROOT,
  TELEGRAM_POLL_ACCOUNT
} from "./config.mjs";
import { loadJson, resolveRuntimePath } from "./util.mjs";

const OPENCLAW_CONFIG_PATH = "/data/.openclaw/openclaw.json";

function resolveCommandBin(name, envValue, absoluteCandidates = []) {
  const candidates = [envValue, ...absoluteCandidates].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync("sh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

const DOCKER_BIN = resolveCommandBin("docker", process.env.DOCKER_BIN, [
  "/usr/bin/docker",
  "/usr/local/bin/docker"
]);

function translateOpenClawPath(filePath, fromRoot, toRoot) {
  if (!filePath || !fromRoot || !toRoot) return null;
  if (!filePath.startsWith(fromRoot)) return null;
  return `${toRoot}${filePath.slice(fromRoot.length)}`;
}

function resolveOpenClawConfigPath() {
  return resolveRuntimePath(OPENCLAW_CONFIG_PATH, [
    translateOpenClawPath(OPENCLAW_CONFIG_PATH, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
    translateOpenClawPath(OPENCLAW_CONFIG_PATH, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
  ]);
}

function resolveContainerEnv(name) {
  if (!DOCKER_BIN) return "";
  try {
    const command = `printf '%s' "\${${name}:-}"`;
    return execFileSync(DOCKER_BIN, [
      "exec",
      CONTAINER,
      "sh",
      "-lc",
      command
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function resolveEnvPlaceholder(value) {
  const match = String(value || "").trim().match(/^\$\{([A-Z0-9_]+)\}$/i);
  if (!match) return String(value || "").trim();
  const envName = match[1];
  return process.env[envName]?.trim() || resolveContainerEnv(envName);
}

export function resolveTelegramAccount(accountId = TELEGRAM_POLL_ACCOUNT) {
  const config = loadJson(resolveOpenClawConfigPath());
  const account = config.channels?.telegram?.accounts?.[accountId];
  if (!account) {
    throw new Error(`telegram account not found in OpenClaw config: ${accountId}`);
  }
  const botToken = resolveEnvPlaceholder(account.botToken);
  if (!botToken) {
    throw new Error(`telegram bot token missing for account ${accountId}`);
  }
  return {
    accountId,
    botToken,
    config: account
  };
}

async function telegramApi(method, payload, { accountId = TELEGRAM_POLL_ACCOUNT } = {}) {
  const { botToken } = resolveTelegramAccount(accountId);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const json = await response.json();
  if (!response.ok || !json?.ok) {
    throw new Error(`telegram ${method} failed: ${JSON.stringify(json)}`);
  }
  return json.result;
}

export async function sendTelegramPoll({
  accountId = TELEGRAM_POLL_ACCOUNT,
  chatId,
  question,
  options,
  allowsMultipleAnswers = true,
  isAnonymous = false,
  disableNotification = false
}) {
  const result = await telegramApi("sendPoll", {
    chat_id: chatId,
    question,
    options,
    allows_multiple_answers: allowsMultipleAnswers,
    is_anonymous: isAnonymous,
    disable_notification: disableNotification
  }, { accountId });
  return {
    chat_id: String(result.chat?.id ?? chatId),
    message_id: String(result.message_id),
    poll_id: result.poll?.id || null,
    poll: result.poll || null
  };
}

export async function stopTelegramPoll({
  accountId = TELEGRAM_POLL_ACCOUNT,
  chatId,
  messageId
}) {
  return telegramApi("stopPoll", {
    chat_id: chatId,
    message_id: Number(messageId)
  }, { accountId });
}

export async function sendTelegramMessage({
  accountId = TELEGRAM_POLL_ACCOUNT,
  chatId,
  text,
  disableNotification = false
}) {
  const result = await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_notification: disableNotification
  }, { accountId });
  return {
    chat_id: String(result.chat?.id ?? chatId),
    message_id: String(result.message_id)
  };
}
