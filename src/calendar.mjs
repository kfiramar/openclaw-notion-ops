import { execFileSync } from "node:child_process";

import { CONTAINER, PRIMARY_CALENDAR_ID } from "./config.mjs";

function parseJsonOutput(output) {
  const parsed = JSON.parse(output);
  return parsed.event || parsed;
}

export function fetchCalendarEvent(eventId, calendarId = PRIMARY_CALENDAR_ID) {
  try {
    const output = execFileSync(
      "docker",
      ["exec", CONTAINER, "gog", "calendar", "event", calendarId, eventId, "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
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
    const output = execFileSync(
      "docker",
      ["exec", CONTAINER, "gog", "calendar", "events", calendarId, "--from", from, "--to", to, "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
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

export function createCalendarEvent(summaryText, start, end, calendarId = PRIMARY_CALENDAR_ID) {
  const output = execFileSync(
    "docker",
    ["exec", CONTAINER, "gog", "calendar", "create", calendarId, "--summary", summaryText, "--from", start, "--to", end, "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return parseJsonOutput(output);
}

export function updateCalendarEvent(eventId, summaryText, start, end, calendarId = PRIMARY_CALENDAR_ID) {
  const output = execFileSync(
    "docker",
    ["exec", CONTAINER, "gog", "calendar", "update", calendarId, eventId, "--summary", summaryText, "--from", start, "--to", end, "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return parseJsonOutput(output);
}

export function deleteCalendarEvent(eventId, calendarId = PRIMARY_CALENDAR_ID) {
  if (!eventId) return { deleted: false };
  execFileSync(
    "docker",
    ["exec", CONTAINER, "gog", "calendar", "delete", calendarId, eventId, "--force", "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return { deleted: true, event_id: eventId };
}
