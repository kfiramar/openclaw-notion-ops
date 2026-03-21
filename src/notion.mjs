import { execFileSync, spawn } from "node:child_process";

import {
  CONTAINER,
  MIRROR_ROOT,
  MIRROR_SYNC,
  MIRROR_SYNC_MATCH,
  NOTION_API
} from "./config.mjs";
import { die, extractPageTitle, normalizePropertyValue, sleep } from "./util.mjs";

export function runNotion(args) {
  return execFileSync("docker", ["exec", CONTAINER, "node", NOTION_API, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function mirrorSyncRunning() {
  try {
    const output = execFileSync("pgrep", ["-af", MIRROR_SYNC_MATCH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return Boolean(output);
  } catch {
    return false;
  }
}

export function waitForMirrorSync(timeoutMs = 30000) {
  const started = Date.now();
  while (mirrorSyncRunning()) {
    if (Date.now() - started > timeoutMs) {
      die(`mirror sync still running after ${timeoutMs}ms`);
    }
    sleep(250);
  }
}

export function runMirrorSync() {
  if (mirrorSyncRunning()) {
    waitForMirrorSync();
    return;
  }
  execFileSync("docker", ["exec", CONTAINER, "node", MIRROR_SYNC, "--root", MIRROR_ROOT], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function kickMirrorSync() {
  if (mirrorSyncRunning()) return;
  try {
    const child = spawn("docker", ["exec", CONTAINER, "node", MIRROR_SYNC, "--root", MIRROR_ROOT], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[notion-board-ops] warning: background mirror sync could not start: ${message}\n`);
  }
}

export function notionRequest(method, apiPath, body, noRefresh = false) {
  const args = ["request", "--method", method, "--path", apiPath, "--body", JSON.stringify(body)];
  if (noRefresh) args.push("--no-refresh");
  return JSON.parse(runNotion(args));
}

export function getPage(pageId) {
  const page = JSON.parse(runNotion(["get-page", "--page-id", pageId]));
  return {
    id: page.id,
    title: extractPageTitle(page),
    archived: Boolean(page.archived || page.in_trash || page.is_archived),
    properties: Object.fromEntries(
      Object.entries(page.properties || {}).map(([name, prop]) => [name, normalizePropertyValue(prop)])
    )
  };
}

export function updatePageProperties(pageId, properties) {
  const filtered = Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined)
  );
  const out = JSON.parse(
    runNotion([
      "update-page",
      "--page-id",
      pageId,
      "--properties",
      JSON.stringify(filtered),
      "--no-refresh"
    ])
  );
  kickMirrorSync();
  return out;
}

export function archivePage(pageId) {
  JSON.parse(runNotion(["archive-page", "--page-id", pageId, "--no-refresh"]));
  kickMirrorSync();
}
