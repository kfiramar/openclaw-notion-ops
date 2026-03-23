import fs from "node:fs";

import { OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT } from "./config.mjs";

const DEFAULT_BASE_URL = process.env.OPENVIKING_BASE_URL || "http://127.0.0.1:1933";
const DEFAULT_TARGET_URI = process.env.OPENVIKING_TARGET_URI || "viking://user/memories";
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENVIKING_TIMEOUT_MS || 5000);

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
];

const DAYPART_WINDOWS = {
  morning: [[9 * 60, 12 * 60]],
  afternoon: [[13 * 60, 17 * 60]],
  evening: [[19 * 60, 22 * 60]],
  night: [[20 * 60, 23 * 60]]
};

function existingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function openClawConfig() {
  const configPath = existingPath([
    `${OPENCLAW_HOST_ROOT}/openclaw.json`,
    `${OPENCLAW_CONTAINER_ROOT}/openclaw.json`,
    process.env.OPENCLAW_CONFIG_PATH || ""
  ]);
  if (!configPath) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function openVikingConfig() {
  const config = openClawConfig();
  return config?.plugins?.entries?.openviking?.config || {};
}

function resolveAuth() {
  const pluginCfg = openVikingConfig();
  return {
    baseUrl: String(pluginCfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: process.env.OPENVIKING_API_KEY || pluginCfg.apiKey || "",
    agentId: process.env.OPENVIKING_AGENT_ID || pluginCfg.agentId || "openclaw-notion-ops",
    targetUri: process.env.OPENVIKING_TARGET_URI || pluginCfg.targetUri || DEFAULT_TARGET_URI
  };
}

async function request(path, init = {}) {
  const auth = resolveAuth();
  if (!auth.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    headers.set("X-API-Key", auth.apiKey);
    headers.set("X-OpenViking-Agent", auth.agentId);

    const response = await fetch(`${auth.baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.status === "error") return null;
    return payload?.result ?? payload ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function compactSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseClock(value) {
  const match = String(value || "").match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function orderedUnique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function expandWeekdayRange(start, end) {
  const startIndex = WEEKDAYS.indexOf(start);
  const endIndex = WEEKDAYS.indexOf(end);
  if (startIndex === -1 || endIndex === -1) return [];
  const output = [];
  let index = startIndex;
  while (true) {
    output.push(WEEKDAYS[index]);
    if (index === endIndex) break;
    index = (index + 1) % WEEKDAYS.length;
  }
  return output;
}

function extractWeekdays(text) {
  const lower = normalizeText(text);
  const days = [];
  const rangePattern =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b\s*(?:-|through|to)\s*\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
  for (const match of lower.matchAll(rangePattern)) {
    days.push(...expandWeekdayRange(match[1], match[2]));
  }
  for (const weekday of WEEKDAYS) {
    if (new RegExp(`\\b${weekday}\\b`, "i").test(lower)) days.push(weekday);
  }
  if (/\bearlier in the week\b/.test(lower)) {
    days.push("sunday", "monday", "tuesday", "wednesday");
  }
  if (/\blater in the week\b/.test(lower)) {
    days.push("wednesday", "thursday", "friday", "saturday");
  }
  return orderedUnique(days);
}

function extractWindows(text) {
  const lower = normalizeText(text);
  const windows = [];
  const rangePattern = /\b(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\b/g;
  for (const match of lower.matchAll(rangePattern)) {
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    if (start !== null && end !== null && end > start) {
      windows.push([start, end]);
    }
  }
  if (windows.length > 0) return windows;

  for (const [part, partWindows] of Object.entries(DAYPART_WINDOWS)) {
    if (new RegExp(`\\b${part}\\b`, "i").test(lower)) {
      windows.push(...partWindows);
    }
  }
  return windows;
}

function scoreResult(result, title, label) {
  const haystack = normalizeText(`${result?.abstract || ""} ${result?.overview || ""} ${result?.category || ""}`);
  const normalizedTitle = normalizeText(title);
  const normalizedLabel = normalizeText(label);
  let score = Number(result?.score || 0) * 100;
  if (normalizedTitle && haystack.includes(normalizedTitle)) score += 200;
  if (normalizedLabel && haystack.includes(normalizedLabel)) score += 120;
  if (haystack.includes("usually")) score += 20;
  if (haystack.includes("prefers")) score += 20;
  if (haystack.includes("fits")) score += 12;
  if (extractWindows(haystack).length > 0) score += 30;
  if (extractWeekdays(haystack).length > 0) score += 15;
  return score;
}

function weekdayName(date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`))
    .toLowerCase();
}

function parsePreference(result, title, label) {
  const text = compactSpaces(`${result?.abstract || ""} ${result?.overview || ""}`);
  if (!text) return null;
  const weekdays = extractWeekdays(text);
  const windows = extractWindows(text);
  if (weekdays.length === 0 && windows.length === 0) return null;
  return {
    text,
    weekdays,
    windows,
    score: scoreResult(result, title, label)
  };
}

export async function findSchedulingPreference({ title, label = title, limit = 8 } = {}) {
  const auth = resolveAuth();
  if (!auth.apiKey || !title) return null;

  const queries = orderedUnique([
    compactSpaces(title),
    compactSpaces(label),
    compactSpaces(`${label} preferred time`),
    compactSpaces(`${title} preferred time`)
  ]).filter(Boolean);

  const results = [];
  for (const query of queries) {
    const response = await request("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify({
        query,
        target_uri: auth.targetUri,
        limit,
        score_threshold: 0
      })
    });
    const memories = response?.memories || response?.resources || [];
    for (const memory of memories) {
      const parsed = parsePreference(memory, title, label);
      if (parsed) results.push(parsed);
    }
  }

  if (results.length === 0) return null;

  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  return {
    summary: best.text,
    weekdays: best.weekdays,
    windows: best.windows,
    score: best.score
  };
}

export async function loadSchedulingPreferenceMap(tasks, labelForTask) {
  const entries = await Promise.all(
    (tasks || []).map(async (task) => {
      const preference = await findSchedulingPreference({
        title: task?.title || "",
        label: typeof labelForTask === "function" ? labelForTask(task) : task?.title || ""
      });
      return [task.id, preference];
    })
  );
  return new Map(entries);
}

export function windowsForDate(preference, date) {
  if (!preference?.windows?.length) return [];
  if (preference.weekdays?.length) {
    const weekday = weekdayName(date);
    if (!preference.weekdays.includes(weekday)) return [];
  }
  return preference.windows.map((window) => [...window]);
}

export function sortDatesByPreference(dates, preference) {
  const values = Array.from(dates || []);
  if (!preference?.weekdays?.length) return values;
  const rank = new Map(preference.weekdays.map((weekday, index) => [weekday, index]));
  return values.sort((a, b) => {
    const aRank = rank.has(weekdayName(a)) ? rank.get(weekdayName(a)) : Number.MAX_SAFE_INTEGER;
    const bRank = rank.has(weekdayName(b)) ? rank.get(weekdayName(b)) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.localeCompare(b);
  });
}
