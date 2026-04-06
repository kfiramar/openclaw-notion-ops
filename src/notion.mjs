import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BOARD_PATH,
  CONTAINER,
  DISABLE_BACKGROUND_SYNC,
  MIRROR_ROOT,
  MIRROR_SYNC,
  MIRROR_SYNC_MATCH,
  NOTION_API,
  OPENCLAW_CONTAINER_ROOT,
  OPENCLAW_HOST_ROOT
} from "./config.mjs";
import { die, extractPageTitle, loadJson, normalizePropertyValue, resolveRuntimePath, sleep } from "./util.mjs";

const FAST_MIRROR_SYNC_SCRIPT = fileURLToPath(new URL("./fast-sync.mjs", import.meta.url));
const FULL_MIRROR_DEFAULT_WAIT_MS = 5000;
const FAST_SYNC_PENDING_FILE = ".fast-sync-pending";

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

function resolveNodeBin() {
  const candidates = [
    process.env.NODE_BIN,
    process.execPath,
    "/usr/bin/node",
    "/usr/local/bin/node",
    "node"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "node") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

const NODE_BIN = resolveNodeBin();
const FAST_MIRROR_SYNC_MATCH = FAST_MIRROR_SYNC_SCRIPT;
const RUNTIME_NOTION_API = resolveRuntimePath(NOTION_API, [
  translateOpenClawPath(NOTION_API, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
  translateOpenClawPath(NOTION_API, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
]);
const RUNTIME_MIRROR_SYNC = resolveRuntimePath(MIRROR_SYNC, [
  translateOpenClawPath(MIRROR_SYNC, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
  translateOpenClawPath(MIRROR_SYNC, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
]);
const RUNTIME_MIRROR_ROOT = resolveRuntimePath(MIRROR_ROOT, [
  translateOpenClawPath(MIRROR_ROOT, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
  translateOpenClawPath(MIRROR_ROOT, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
]);
const NOTION_COMMAND = DOCKER_BIN
  ? { bin: DOCKER_BIN, prefix: ["exec", CONTAINER, "node", NOTION_API] }
  : { bin: NODE_BIN, prefix: [RUNTIME_NOTION_API] };
const FULL_SYNC_COMMAND = DOCKER_BIN
  ? { bin: DOCKER_BIN, args: ["exec", CONTAINER, "node", MIRROR_SYNC, "--root", MIRROR_ROOT] }
  : { bin: NODE_BIN, args: [RUNTIME_MIRROR_SYNC, "--root", RUNTIME_MIRROR_ROOT] };

function normalizePage(page) {
  return {
    id: page.id,
    title: extractPageTitle(page),
    url: page.url || null,
    created_time: page.created_time || null,
    last_edited_time: page.last_edited_time || null,
    archived: Boolean(page.archived || page.in_trash || page.is_archived),
    parent: page.parent || null,
    properties: Object.fromEntries(
      Object.entries(page.properties || {}).map(([name, prop]) => [name, normalizePropertyValue(prop)])
    )
  };
}

export function runNotion(args) {
  return execFileSync(NOTION_COMMAND.bin, [...NOTION_COMMAND.prefix, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function hostProcessRunning(match) {
  try {
    const output = execFileSync("pgrep", ["-af", match], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return Boolean(output);
  } catch {
    return false;
  }
}

function containerProcessRunning(match) {
  if (!DOCKER_BIN) return hostProcessRunning(match);
  try {
    const output = execFileSync(DOCKER_BIN, ["exec", CONTAINER, "pgrep", "-af", match], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return Boolean(output);
  } catch {
    return false;
  }
}

function fullMirrorSyncRunning() {
  return hostProcessRunning(MIRROR_SYNC_MATCH) || containerProcessRunning(MIRROR_SYNC_MATCH);
}

function fastMirrorSyncRunning() {
  return hostProcessRunning(FAST_MIRROR_SYNC_MATCH);
}

export function mirrorSyncRunning({ full = false } = {}) {
  return full ? fullMirrorSyncRunning() : fastMirrorSyncRunning();
}

export function waitForMirrorSync(timeoutMs = 30000, { full = false } = {}) {
  const started = Date.now();
  while (mirrorSyncRunning({ full })) {
    if (Date.now() - started > timeoutMs) {
      return { completed: false, waited_ms: Date.now() - started };
    }
    sleep(250);
  }
  return { completed: true, waited_ms: Date.now() - started };
}

function translateOpenClawPath(filePath, fromRoot, toRoot) {
  if (!filePath || !fromRoot || !toRoot) return null;
  if (!filePath.startsWith(fromRoot)) return null;
  return `${toRoot}${filePath.slice(fromRoot.length)}`;
}

function resolveBoardPath(filePath) {
  return resolveRuntimePath(filePath, [
    translateOpenClawPath(filePath, OPENCLAW_CONTAINER_ROOT, OPENCLAW_HOST_ROOT),
    translateOpenClawPath(filePath, OPENCLAW_HOST_ROOT, OPENCLAW_CONTAINER_ROOT)
  ]);
}

function fastSyncPendingPath() {
  return path.join(resolveBoardPath(MIRROR_ROOT), FAST_SYNC_PENDING_FILE);
}

function markFastSyncPending() {
  const filePath = fastSyncPendingPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${Date.now()}\n`, "utf8");
}

export function clearFastSyncPending() {
  fs.rmSync(fastSyncPendingPath(), { force: true });
}

export function fastSyncPending() {
  return fs.existsSync(fastSyncPendingPath());
}

function ensureWritableMirrorDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    const stat = fs.statSync(dir);
    const mode = (stat.mode & 0o777).toString(8);
    throw new Error(
      `mirror directory is not writable: ${dir} (uid=${stat.uid} gid=${stat.gid} mode=${mode}). ` +
        `Fix with: chown -R node:node ${dir}`
    );
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureWritableMirrorDir(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function boardSyncTargets() {
  const board = loadJson(resolveBoardPath(BOARD_PATH));
  return Object.entries(board.databases || {})
    .map(([, entry]) => ({
      dataSourceId: entry?.data_source_id || null,
      mirrorFile: entry?.mirror_file ? resolveBoardPath(entry.mirror_file) : null
    }))
    .filter((entry) => entry.dataSourceId && entry.mirrorFile);
}

export function getDataSource(dataSourceId) {
  return notionRequest("GET", `/v1/data_sources/${dataSourceId}`, undefined, true);
}

export function runBoardMirrorSync() {
  const syncedAt = new Date().toISOString();
  for (const target of boardSyncTargets()) {
    const dataSource = getDataSource(target.dataSourceId);
    const rows = queryDataSourceRows(target.dataSourceId);
    writeJsonAtomic(target.mirrorFile, {
      syncedAt,
      dataSource: {
        id: dataSource.id,
        title: extractPageTitle(dataSource),
        url: dataSource.url || null,
        created_time: dataSource.created_time || null,
        last_edited_time: dataSource.last_edited_time || null,
        properties: dataSource.properties || {}
      },
      rows
    });
  }
}

function fullMirrorPaths() {
  const hostRoot = resolveBoardPath(MIRROR_ROOT);
  return {
    host_root: hostRoot,
    log_path: path.join(hostRoot, "full-sync.log")
  };
}

function currentFullMirrorStatus() {
  const paths = fullMirrorPaths();
  return {
    ...paths,
    log_path: fs.existsSync(paths.log_path) ? paths.log_path : null
  };
}

function startFullMirrorSync() {
  const { host_root, log_path } = fullMirrorPaths();
  fs.mkdirSync(host_root, { recursive: true });
  const logFd = fs.openSync(log_path, "a");
  fs.writeSync(logFd, `[${new Date().toISOString()}] starting full mirror sync\n`);
  const child = spawn(FULL_SYNC_COMMAND.bin, FULL_SYNC_COMMAND.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return {
    pid: child.pid,
    ...fullMirrorPaths()
  };
}

export function runMirrorSync({ full = false, waitMs } = {}) {
  if (mirrorSyncRunning({ full })) {
    const timeoutMs = full ? Number(waitMs ?? FULL_MIRROR_DEFAULT_WAIT_MS) : 15000;
    const result = waitForMirrorSync(timeoutMs, { full });
    if (!full && !result.completed) {
      die(`mirror sync still running after ${timeoutMs}ms`);
    }
    return full
      ? {
          ok: true,
          mode: "full-workspace",
          state: result.completed ? "completed-existing" : "running-existing",
          ...currentFullMirrorStatus(),
          ...result
        }
      : {
          ok: true,
          mode: "fast-board",
          state: "completed-existing",
          ...result
        };
  }
  if (!full) {
    runBoardMirrorSync();
    return { ok: true, mode: "fast-board", state: "completed" };
  }
  const launched = startFullMirrorSync();
  const result = waitForMirrorSync(Number(waitMs ?? FULL_MIRROR_DEFAULT_WAIT_MS), { full: true });
  return {
    ok: true,
    mode: "full-workspace",
    state: result.completed ? "completed" : "started-background",
    ...launched,
    ...result
  };
}

export function kickMirrorSync() {
  if (DISABLE_BACKGROUND_SYNC) return;
  markFastSyncPending();
  if (fastMirrorSyncRunning()) return;
  try {
    const child = spawn(NODE_BIN, [FAST_MIRROR_SYNC_SCRIPT], {
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
  const args = ["request", "--method", method, "--path", apiPath];
  if (body !== undefined) args.push("--body", JSON.stringify(body));
  if (noRefresh) args.push("--no-refresh");
  return JSON.parse(runNotion(args));
}

export function getPage(pageId) {
  const page = JSON.parse(runNotion(["get-page", "--page-id", pageId]));
  return normalizePage(page);
}

export function queryDataSourceRows(dataSourceId) {
  const rows = [];
  let startCursor = null;

  for (;;) {
    const body = startCursor ? { start_cursor: startCursor } : {};
    const out = notionRequest("POST", `/v1/data_sources/${dataSourceId}/query`, body, true);
    rows.push(...(out.results || []).map(normalizePage));
    if (!out.has_more || !out.next_cursor) break;
    startCursor = out.next_cursor;
  }

  return rows;
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
