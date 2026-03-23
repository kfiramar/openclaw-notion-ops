#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const workspaceRoot =
  process.env.OPENCLAW_WORKSPACE || "/docker/openclaw-pma3/data/.openclaw/workspace-personal";
const boardPath = process.env.BOARD_PATH || `${workspaceRoot}/LIFESTYLE_BOARD.json`;
const container = process.env.OPENCLAW_CONTAINER || "openclaw-pma3-openclaw-1";
const notionApiPath =
  process.env.NOTION_API_PATH || "/data/.openclaw/skills/notion-api/scripts/notion-api.mjs";
const wrapperPath = `${workspaceRoot}/lifestyle-ops.mjs`;
const timeZone = process.env.DASHBOARD_TIME_ZONE || "Asia/Jerusalem";
const explicitDate = process.env.DASHBOARD_DATE || null;

const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));

function notionJson(args) {
  const output = execFileSync(
    "docker",
    ["exec", container, "node", notionApiPath, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(output);
}

function wrapperJson(args) {
  const output = execFileSync("node", [wrapperPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(output);
}

function blockChildren(blockId) {
  return notionJson(["block-children", "--block-id", blockId, "--page-size", "100"]).results || [];
}

function updateBlock(blockId, body) {
  return notionJson(["update-block", "--block-id", blockId, "--body", JSON.stringify(body), "--no-refresh"]);
}

function appendBlocks(blockId, children) {
  return notionJson([
    "append-blocks",
    "--block-id",
    blockId,
    "--body",
    JSON.stringify({ children }),
    "--no-refresh"
  ]);
}

function archiveBlock(blockId) {
  return updateBlock(blockId, { archived: true });
}

function replaceBlockChildren(blockId, children) {
  const existing = blockChildren(blockId);
  for (const block of existing) archiveBlock(block.id);
  appendBlocks(blockId, children);
  return existing.length;
}

function text(content, { link = null, bold = false } = {}) {
  return {
    type: "text",
    text: {
      content,
      link: link ? { url: link } : null
    },
    annotations: {
      bold,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default"
    },
    plain_text: content,
    href: link || null
  };
}

function inlineLinks(title, items) {
  const richText = [text(`${title}\n`, { bold: true })];
  items.forEach((item, index) => {
    richText.push(text(item.label, { link: item.url, bold: index === 0 }));
    if (index < items.length - 1) richText.push(text(" • "));
  });
  return richText;
}

function heading1(value) {
  return {
    object: "block",
    type: "heading_1",
    heading_1: {
      rich_text: [text(value)],
      is_toggleable: false,
      color: "default"
    }
  };
}

function heading2(value) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [text(value)],
      is_toggleable: false,
      color: "default"
    }
  };
}

function paragraph(value) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [text(value)],
      color: "default"
    }
  };
}

function bullet(parts) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: parts,
      color: "default"
    }
  };
}

function titleBullet(row) {
  return bullet([text(row.title || "Untitled task", { link: notionPageUrl(row.id), bold: true })]);
}

function callout({ icon, color, title, items }) {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: inlineLinks(title, items),
      icon: { type: "emoji", emoji: icon },
      color
    }
  };
}

function updateCallout(blockId, { icon, color, title, items }) {
  return updateBlock(blockId, {
    type: "callout",
    callout: {
      rich_text: inlineLinks(title, items),
      icon: { type: "emoji", emoji: icon },
      color
    }
  });
}

function replacePageChildren(pageId, children) {
  return replaceBlockChildren(pageId, children);
}

function currentDateInTimeZone(zone = timeZone) {
  if (explicitDate) return explicitDate;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekdayShort(date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`)
  );
}

function startOfWeek(date) {
  const value = new Date(`${date}T00:00:00Z`);
  const weekday = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() - weekday);
  return value.toISOString().slice(0, 10);
}

function endOfWeek(date) {
  return addDays(startOfWeek(date), 6);
}

function notionPageUrl(id) {
  if (!id) return null;
  return `https://www.notion.so/${String(id).replace(/-/g, "")}`;
}

function timeLabel(start, end) {
  if (!start) return "Unscheduled";
  const startTime = String(start).slice(11, 16);
  const endTime = end ? String(end).slice(11, 16) : null;
  return endTime ? `${startTime}-${endTime}` : startTime;
}

function snapshotBullet(row, { showTime = false, fallback = null } = {}) {
  const label = showTime ? timeLabel(row.scheduled_start, row.scheduled_end || null) : (fallback || row.status || "todo");
  return bullet([
    text(`${label} — `),
    text(row.title || "Untitled task", { link: notionPageUrl(row.id), bold: true })
  ]);
}

function datedSnapshotBullet(row) {
  const date = String(row.scheduled_start || "").slice(0, 10);
  const prefix = date ? `${weekdayShort(date)} ${timeLabel(row.scheduled_start, row.scheduled_end || null)}` : "Unscheduled";
  return bullet([
    text(`${prefix} — `),
    text(row.title || "Untitled task", { link: notionPageUrl(row.id), bold: true })
  ]);
}

function todaySnapshotBlocks() {
  const date = currentDateInTimeZone();
  const today = (wrapperJson(["show", "--view", "today"]).rows || []).filter((row) => row.status !== "done");
  const calendar = wrapperJson(["show", "--view", "calendar"]).rows || [];
  const unscheduledToday = today.filter((row) => !row.scheduled_start);
  const scheduledToday = calendar
    .filter((row) => String(row.scheduled_start || "").slice(0, 10) === date)
    .sort((a, b) => String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || "")));
  const needsTimeToday = today.filter((row) => row.needs_calendar === true && !row.scheduled_start);

  const blocks = [
    heading2(`Live Today (${date})`)
  ];

  if (unscheduledToday.length > 0) {
    blocks.push(paragraph("Today tasks"));
    for (const row of unscheduledToday) {
      blocks.push(snapshotBullet(row, { fallback: "Unscheduled" }));
    }
  }

  if (scheduledToday.length > 0) {
    blocks.push(heading2("Today Scheduled"));
    for (const row of scheduledToday) {
      blocks.push(snapshotBullet(row, { showTime: true }));
    }
  }

  if (needsTimeToday.length > 0) {
    blocks.push(heading2("Today Needs Time"));
    for (const row of needsTimeToday) {
      blocks.push(snapshotBullet(row, { fallback: "Needs slot" }));
    }
  }

  if (unscheduledToday.length === 0 && scheduledToday.length === 0 && needsTimeToday.length === 0) {
    blocks.push(paragraph("No live today items right now."));
  }

  return blocks;
}

function weeklySnapshotBlocks() {
  const date = currentDateInTimeZone();
  const week = wrapperJson(["show", "--view", "week"]).rows || [];
  const calendar = wrapperJson(["show", "--view", "calendar"]).rows || [];
  const weekStart = startOfWeek(date);
  const weekEnd = endOfWeek(date);
  const scheduledThisWeek = calendar
    .filter((row) => {
      const day = String(row.scheduled_start || "").slice(0, 10);
      return Boolean(day) && day >= weekStart && day <= weekEnd;
    })
    .sort((a, b) => String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || "")));
  const missingTime = week.filter((row) => row.needs_calendar === true && !row.scheduled_start && row.status !== "done");

  const blocks = [
    heading2("Live This Week")
  ];

  if (week.length > 0) {
    blocks.push(paragraph("Weekly commitments"));
    for (const row of week.slice(0, 12)) {
      blocks.push(snapshotBullet(row, { showTime: true }));
    }
  }

  if (scheduledThisWeek.length > 0) {
    blocks.push(heading2("This Week Scheduled"));
    for (const row of scheduledThisWeek.slice(0, 12)) {
      blocks.push(datedSnapshotBullet(row));
    }
  }

  if (missingTime.length > 0) {
    blocks.push(heading2("This Week Needs Time"));
    for (const row of missingTime.slice(0, 12)) {
      blocks.push(snapshotBullet(row, { fallback: "Needs slot" }));
    }
  }

  if (week.length === 0 && scheduledThisWeek.length === 0 && missingTime.length === 0) {
    blocks.push(paragraph("No live weekly items right now."));
  }

  return blocks;
}

function rootTodaySnapshotBlocks() {
  const date = currentDateInTimeZone();
  const today = (wrapperJson(["show", "--view", "today"]).rows || []).filter((row) => row.status !== "done");
  const calendar = wrapperJson(["show", "--view", "calendar"]).rows || [];
  const scheduledToday = calendar
    .filter((row) => String(row.scheduled_start || "").slice(0, 10) === date)
    .sort((a, b) => String(a.scheduled_start || "").localeCompare(String(b.scheduled_start || "")));
  const unscheduledToday = today.filter((row) => !row.scheduled_start);
  const liveRows = [...scheduledToday, ...unscheduledToday.filter((row) => row.needs_calendar === true)].slice(0, 5);

  const blocks = [heading2("Live Today")];
  if (liveRows.length === 0) {
    blocks.push(paragraph("No live today items right now."));
    return blocks;
  }

  for (const row of liveRows) {
    blocks.push(snapshotBullet(row, { showTime: Boolean(row.scheduled_start), fallback: "Needs slot" }));
  }

  return blocks;
}

function rootWeeklySnapshotBlocks() {
  const week = wrapperJson(["show", "--view", "week"]).rows || [];
  const weeklyRows = uniqueLiveRows(week);

  const blocks = [heading2("Live This Week")];
  if (weeklyRows.length === 0) {
    blocks.push(paragraph("No live weekly items right now."));
    return blocks;
  }

  for (const row of weeklyRows) {
    blocks.push(titleBullet(row));
  }

  return blocks;
}

function uniqueLiveRows(rows) {
  const liveRows = [];
  const seen = new Set();

  for (const row of rows || []) {
    if (row.status === "done" || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    liveRows.push(row);
  }

  return liveRows;
}

function rootMonthlySnapshotBlocks() {
  const monthRows = uniqueLiveRows(wrapperJson(["show", "--view", "month"]).rows || []);
  const blocks = [heading2("Live This Month")];
  if (monthRows.length === 0) {
    blocks.push(paragraph("No live monthly items right now."));
    return blocks;
  }

  for (const row of monthRows) {
    blocks.push(titleBullet(row));
  }

  return blocks;
}

function rootYearlySnapshotBlocks() {
  const yearRows = uniqueLiveRows(wrapperJson(["show", "--view", "year"]).rows || []);
  const blocks = [heading2("Live This Year")];
  if (yearRows.length === 0) {
    blocks.push(paragraph("No live yearly items right now."));
    return blocks;
  }

  for (const row of yearRows) {
    blocks.push(titleBullet(row));
  }

  return blocks;
}

function rootColumnIds() {
  const rootChildren = blockChildren(board.system.root_page.id);
  const columnList = rootChildren.find((block) => block.type === "column_list");
  if (!columnList) throw new Error("root page does not contain a column list");
  const columns = blockChildren(columnList.id).filter((block) => block.type === "column");
  if (columns.length < 2) throw new Error("root page column list is incomplete");
  return columns.map((column) => column.id);
}

function syncRootDashboard() {
  const [leftColumnId, rightColumnId] = rootColumnIds();
  const leftCallouts = blockChildren(leftColumnId).filter((block) => block.type === "callout");
  const rightCallouts = blockChildren(rightColumnId).filter((block) => block.type === "callout");
  if (leftCallouts.length < 2 || rightCallouts.length < 2) {
    throw new Error("root dashboard columns do not have the expected callout layout");
  }

  updateCallout(leftCallouts[0].id, {
    icon: "☀️",
    color: "yellow_background",
    title: "Today",
    items: [
      { label: "Daily Command Center", url: board.pages.daily.url },
      { label: "Today Execution", url: board.tasks.views.today_list.url },
      { label: "Today Needs Time", url: board.tasks.views.needs_scheduling.url },
      { label: "Scheduled Calendar", url: board.tasks.views.calendar.url }
    ]
  });
  updateCallout(leftCallouts[1].id, {
    icon: "🗓️",
    color: "orange_background",
    title: "This Month",
    items: [
      { label: "This Month List", url: board.tasks.views.this_month_list.url },
      { label: "Monthly Table", url: board.tasks.views.monthly.url },
      { label: "Active Projects", url: board.projects.views.active.url },
      { label: "Scheduled Calendar", url: board.tasks.views.calendar.url }
    ]
  });
  updateCallout(rightCallouts[0].id, {
    icon: "📅",
    color: "blue_background",
    title: "This Week",
    items: [
      { label: "Weekly Reset", url: board.pages.weekly.url },
      { label: "This Week List", url: board.tasks.views.this_week_list.url },
      { label: "Goal Work", url: board.tasks.views.goal_work.url },
      { label: "Projects by Area", url: board.projects.views.by_area.url }
    ]
  });
  updateCallout(rightCallouts[1].id, {
    icon: "🎯",
    color: "purple_background",
    title: "This Year",
    items: [
      { label: "This Year List", url: board.tasks.views.this_year_list.url },
      { label: "Yearly Goals", url: board.goals.views.yearly.url },
      { label: "Goals by Health", url: board.goals.views.by_health.url }
    ]
  });

  const todayArchived = replaceBlockChildren(leftCallouts[0].id, rootTodaySnapshotBlocks());
  const monthArchived = replaceBlockChildren(leftCallouts[1].id, rootMonthlySnapshotBlocks());
  const weekArchived = replaceBlockChildren(rightCallouts[0].id, rootWeeklySnapshotBlocks());
  const yearArchived = replaceBlockChildren(rightCallouts[1].id, rootYearlySnapshotBlocks());

  return {
    updated_callouts: [
      leftCallouts[0].id,
      leftCallouts[1].id,
      rightCallouts[0].id,
      rightCallouts[1].id
    ],
    archived_child_blocks: {
      today: todayArchived,
      month: monthArchived,
      week: weekArchived,
      year: yearArchived
    }
  };
}

function syncDailyDashboard() {
  const archived = replacePageChildren(board.pages.daily.id, [
    heading1("Daily Command Center"),
    paragraph(
      "Work from Today Execution to check things off. Use Scheduled Calendar for exact placement, and Today Needs Time for today work that still needs a slot."
    ),
    ...todaySnapshotBlocks(),
    callout({
      icon: "⚡",
      color: "yellow_background",
      title: "Execute",
      items: [
        { label: "Today Execution", url: board.tasks.views.today_list.url },
        { label: "Daily Table", url: board.tasks.views.daily.url },
        { label: "Scheduled Calendar", url: board.tasks.views.calendar.url }
      ]
    }),
    callout({
      icon: "🧭",
      color: "gray_background",
      title: "Decide",
      items: [
        { label: "Today Needs Time", url: board.tasks.views.needs_scheduling.url },
        { label: "Inbox", url: board.tasks.views.inbox.url },
        { label: "Blocked", url: board.tasks.views.blocked.url },
        { label: "This Week List", url: board.tasks.views.this_week_list.url }
      ]
    }),
    callout({
      icon: "🦞",
      color: "blue_background",
      title: "Control",
      items: [
        { label: "Lifestyle OS", url: board.system.root_page.url },
        { label: "OpenClaw Command Board", url: board.system.command_board.url }
      ]
    })
  ]);
  return { archived_blocks: archived };
}

function syncWeeklyDashboard() {
  const archived = replacePageChildren(board.pages.weekly.id, [
    heading1("Weekly Reset"),
    paragraph(
      "Shape the week from live views. Use This Week List for commitments, Scheduled Calendar for placed blocks, and Goal or Project views for weekly shaping."
    ),
    ...weeklySnapshotBlocks(),
    callout({
      icon: "📅",
      color: "blue_background",
      title: "Execute",
      items: [
        { label: "This Week List", url: board.tasks.views.this_week_list.url },
        { label: "Weekly Table", url: board.tasks.views.weekly.url },
        { label: "Scheduled Calendar", url: board.tasks.views.calendar.url }
      ]
    }),
    callout({
      icon: "🧭",
      color: "green_background",
      title: "Shape",
      items: [
        { label: "Goal Work", url: board.tasks.views.goal_work.url },
        { label: "Projects by Area", url: board.projects.views.by_area.url },
        { label: "This Month List", url: board.tasks.views.this_month_list.url },
        { label: "Blocked", url: board.tasks.views.blocked.url }
      ]
    }),
    callout({
      icon: "🎯",
      color: "purple_background",
      title: "Annual Context",
      items: [
        { label: "This Year List", url: board.tasks.views.this_year_list.url },
        { label: "Yearly Goals", url: board.goals.views.yearly.url },
        { label: "Goals by Health", url: board.goals.views.by_health.url }
      ]
    })
  ]);
  return { archived_blocks: archived };
}

const result = {
  ok: true,
  action: "sync-dashboards",
  board_path: boardPath,
  root: syncRootDashboard(),
  daily: syncDailyDashboard(),
  weekly: syncWeeklyDashboard(),
  limitations: [
    "Notion API does not support creating or editing database views, so this sync updates dashboard navigation blocks only.",
    "Notion API does not support updating formula properties on this data source, so scan-friendly formula columns still need manual setup in Notion."
  ]
};

console.log(JSON.stringify(result, null, 2));
