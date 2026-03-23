#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const workspaceRoot =
  process.env.OPENCLAW_WORKSPACE || "/docker/openclaw-pma3/data/.openclaw/workspace-personal";
const boardPath = process.env.BOARD_PATH || `${workspaceRoot}/LIFESTYLE_BOARD.json`;
const container = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
const notionApiPath =
  process.env.NOTION_API_PATH || "/data/.openclaw/skills/notion-api/scripts/notion-api.mjs";

const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));

function notionJson(args) {
  const output = execFileSync(
    "docker",
    ["exec", container, "node", notionApiPath, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(output);
}

function blockChildren(blockId) {
  return notionJson(["block-children", "--block-id", blockId, "--page-size", "100"]).results || [];
}

function richTextContent(block) {
  const payload = block[block.type] || {};
  const parts = payload.rich_text || [];
  return parts.map((part) => part.plain_text || "").join("");
}

function richTextLinks(block) {
  const payload = block[block.type] || {};
  const parts = payload.rich_text || [];
  return parts.map((part) => part.href).filter(Boolean);
}

function hasLink(blocks, url) {
  return blocks.some((block) => richTextLinks(block).includes(url));
}

function hasHeading(blocks, text) {
  return blocks.some((block) => /heading_/.test(block.type) && richTextContent(block).includes(text));
}

function pageChecks(pageId, required) {
  const blocks = blockChildren(pageId);
  return required.map((entry) => ({
    label: entry.label,
    ok: entry.type === "heading" ? hasHeading(blocks, entry.value) : hasLink(blocks, entry.value)
  }));
}

const rootColumnList = blockChildren(board.system.root_page.id).find((block) => block.type === "column_list");
const rootColumns = rootColumnList ? blockChildren(rootColumnList.id).filter((block) => block.type === "column") : [];
const rootBlocks = rootColumns.flatMap((column) => blockChildren(column.id));
const rootTodayCallout = rootBlocks.find(
  (block) => block.type === "callout" && richTextContent(block).includes("Today")
);
const rootMonthCallout = rootBlocks.find(
  (block) => block.type === "callout" && richTextContent(block).includes("This Month")
);
const rootWeekCallout = rootBlocks.find(
  (block) => block.type === "callout" && richTextContent(block).includes("This Week")
);
const rootYearCallout = rootBlocks.find(
  (block) => block.type === "callout" && richTextContent(block).includes("This Year")
);
const rootTodayChildren = rootTodayCallout ? blockChildren(rootTodayCallout.id) : [];
const rootMonthChildren = rootMonthCallout ? blockChildren(rootMonthCallout.id) : [];
const rootWeekChildren = rootWeekCallout ? blockChildren(rootWeekCallout.id) : [];
const rootYearChildren = rootYearCallout ? blockChildren(rootYearCallout.id) : [];

const results = {
  ok: true,
  action: "check-dashboards",
  root: [
    { label: "daily page", ok: hasLink(rootBlocks, board.pages.daily.url) },
    { label: "today execution", ok: hasLink(rootBlocks, board.tasks.views.today_list.url) },
    { label: "today needs time", ok: hasLink(rootBlocks, board.tasks.views.needs_scheduling.url) },
    { label: "weekly page", ok: hasLink(rootBlocks, board.pages.weekly.url) },
    { label: "root today live list", ok: hasHeading(rootTodayChildren, "Live Today") },
    { label: "root month live list", ok: hasHeading(rootMonthChildren, "Live This Month") },
    { label: "root week live list", ok: hasHeading(rootWeekChildren, "Live This Week") },
    { label: "root year live list", ok: hasHeading(rootYearChildren, "Live This Year") }
  ],
  daily: pageChecks(board.pages.daily.id, [
    { label: "daily heading", type: "heading", value: "Daily Command Center" },
    { label: "live today heading", type: "heading", value: "Live Today" },
    { label: "today execution link", type: "link", value: board.tasks.views.today_list.url },
    { label: "today needs time link", type: "link", value: board.tasks.views.needs_scheduling.url },
    { label: "calendar link", type: "link", value: board.tasks.views.calendar.url }
  ]),
  weekly: pageChecks(board.pages.weekly.id, [
    { label: "weekly heading", type: "heading", value: "Weekly Reset" },
    { label: "live this week heading", type: "heading", value: "Live This Week" },
    { label: "this week list link", type: "link", value: board.tasks.views.this_week_list.url },
    { label: "goal work link", type: "link", value: board.tasks.views.goal_work.url },
    { label: "calendar link", type: "link", value: board.tasks.views.calendar.url }
  ])
};

const failures = [...results.root, ...results.daily, ...results.weekly].filter((item) => item.ok !== true);
results.ok = failures.length === 0;
results.failed = failures;

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
