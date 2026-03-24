import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { CONTAINER, PRIMARY_CALENDAR_ID } from "./config.mjs";

function resolveCommandBin(name, envValue, absoluteCandidates = []) {
  const candidates = [
    envValue,
    ...absoluteCandidates
  ].filter(Boolean);
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
const GOG_BIN = resolveCommandBin("gog", process.env.GOG_BIN, [
  "/usr/local/bin/gog",
  "/usr/bin/gog"
]);
const CALENDAR_COMMAND = DOCKER_BIN
  ? { bin: DOCKER_BIN, prefix: ["exec", CONTAINER, "gog"] }
  : { bin: GOG_BIN || "gog", prefix: [] };

function parseJsonOutput(output) {
  const parsed = JSON.parse(output);
  return parsed.event || parsed;
}

function runCalendar(args) {
  return execFileSync(CALENDAR_COMMAND.bin, [...CALENDAR_COMMAND.prefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function fetchCalendarEvent(eventId, calendarId = PRIMARY_CALENDAR_ID) {
  try {
    const output = runCalendar(["calendar", "event", calendarId, eventId, "--json"]);
    return { ok: true, event: parseJsonOutput(output) };
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 1;
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    return {
      ok: false,
      status,
      stderr,
      stdout,
      notFound: status === 5 || /404\b|not found/i.test(stderr)
    };
  }
}

export function fetchCalendarEventsInRange(from, to, calendarId = PRIMARY_CALENDAR_ID) {
  try {
    const output = runCalendar(["calendar", "events", calendarId, "--from", from, "--to", to, "--json"]);
    const parsed = JSON.parse(output);
    return { ok: true, events: parsed.events || [] };
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 1;
    return {
      ok: false,
      status,
      stderr: String(error?.stderr || "").trim(),
      stdout: String(error?.stdout || "").trim()
    };
  }
}

function recurrenceArgs(rrules = []) {
  const values = Array.isArray(rrules) ? rrules : (rrules ? [rrules] : []);
  return values.flatMap((rule) => ["--rrule", rule]);
}

function isDateOnlyValue(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function allDayArgs(start, end) {
  return isDateOnlyValue(start) && isDateOnlyValue(end) ? ["--all-day"] : [];
}

export function createCalendarEvent(summaryText, start, end, calendarId = PRIMARY_CALENDAR_ID, options = {}) {
  const output = runCalendar([
    "calendar",
    "create",
    calendarId,
    "--summary",
    summaryText,
    "--from",
    start,
    "--to",
    end,
    ...allDayArgs(start, end),
    ...recurrenceArgs(options.rrules),
    "--json"
  ]);
  return parseJsonOutput(output);
}

export function updateCalendarEvent(eventId, summaryText, start, end, calendarId = PRIMARY_CALENDAR_ID, options = {}) {
  const output = runCalendar([
    "calendar",
    "update",
    calendarId,
    eventId,
    "--summary",
    summaryText,
    "--from",
    start,
    "--to",
    end,
    ...allDayArgs(start, end),
    ...recurrenceArgs(options.rrules),
    "--json"
  ]);
  return parseJsonOutput(output);
}

export function deleteCalendarEvent(eventId, calendarId = PRIMARY_CALENDAR_ID) {
  if (!eventId) return { deleted: false };
  runCalendar(["calendar", "delete", calendarId, eventId, "--force", "--json"]);
  return { deleted: true, event_id: eventId };
}
