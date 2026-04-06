#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const NOTION_VERSION = process.env.NOTION_VERSION || "2025-09-03";
const DEFAULT_CONCURRENCY = Number(process.env.NOTION_MIRROR_CONCURRENCY || "6");
let notionTokenPromise = null;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function slugify(value) {
  return String(value || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

function truncate(value, max = 120) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function joinPlainText(items) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => item?.plain_text || item?.text?.content || "").join("").trim();
}

function normalizeFormula(formula) {
  if (!formula || typeof formula !== "object") return null;
  switch (formula.type) {
    case "string":
      return formula.string;
    case "number":
      return formula.number;
    case "boolean":
      return formula.boolean;
    case "date":
      return formula.date;
    default:
      return formula[formula.type] ?? null;
  }
}

function normalizePropertyValue(prop) {
  if (!prop || typeof prop !== "object") return null;
  switch (prop.type) {
    case "title":
      return joinPlainText(prop.title);
    case "rich_text":
      return joinPlainText(prop.rich_text);
    case "status":
      return prop.status?.name || null;
    case "select":
      return prop.select?.name || null;
    case "multi_select":
      return Array.isArray(prop.multi_select) ? prop.multi_select.map((item) => item.name) : [];
    case "people":
      return Array.isArray(prop.people)
        ? prop.people.map((person) => person.name || person.person?.email || person.id)
        : [];
    case "date":
      return prop.date ? { start: prop.date.start, end: prop.date.end, time_zone: prop.date.time_zone } : null;
    case "checkbox":
      return !!prop.checkbox;
    case "number":
      return prop.number;
    case "url":
      return prop.url || null;
    case "email":
      return prop.email || null;
    case "phone_number":
      return prop.phone_number || null;
    case "relation":
      return Array.isArray(prop.relation) ? prop.relation.map((item) => item.id) : [];
    case "files":
      return Array.isArray(prop.files)
        ? prop.files.map((file) => ({
            name: file.name,
            url: file.file?.url || file.external?.url || null
          }))
        : [];
    case "formula":
      return normalizeFormula(prop.formula);
    case "created_time":
      return prop.created_time || null;
    case "last_edited_time":
      return prop.last_edited_time || null;
    case "created_by":
    case "last_edited_by":
      return prop[prop.type]?.name || prop[prop.type]?.id || null;
    default:
      return prop[prop.type] ?? null;
  }
}

function pickTitleProperty(properties) {
  for (const [name, prop] of Object.entries(properties || {})) {
    if (prop?.type === "title") return name;
  }
  return null;
}

function extractTitle(item) {
  const titleProperty = pickTitleProperty(item.properties || {});
  if (titleProperty) {
    const value = normalizePropertyValue(item.properties[titleProperty]);
    if (value) return value;
  }
  if (Array.isArray(item.title)) return joinPlainText(item.title);
  return item.id;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function parseOwnerSpec(spec) {
  if (!spec) return null;
  const match = String(spec).trim().match(/^(\d+):(\d+)$/);
  if (!match) {
    throw new Error(`invalid owner spec ${JSON.stringify(spec)}; expected UID:GID`);
  }
  return {
    uid: Number(match[1]),
    gid: Number(match[2])
  };
}

async function resolveDesiredOwnership(root, explicitOwner = null) {
  if (explicitOwner) return explicitOwner;
  const stats = await fs.stat(root);
  if (typeof stats.uid !== "number" || typeof stats.gid !== "number") return null;
  return {
    uid: stats.uid,
    gid: stats.gid
  };
}

async function applyOwnershipRecursive(target, owner) {
  if (!owner || typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const stats = await fs.lstat(target);
  if (stats.uid !== owner.uid || stats.gid !== owner.gid) {
    await fs.chown(target, owner.uid, owner.gid);
  }
  if (!stats.isDirectory()) return;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await applyOwnershipRecursive(path.join(target, entry.name), owner);
  }
}

async function readToken() {
  if (!notionTokenPromise) {
    notionTokenPromise = (async () => {
      if (process.env.NOTION_KEY?.trim()) return process.env.NOTION_KEY.trim();
      const fallback = path.join(os.homedir(), ".config", "notion", "api_key");
      const contents = await fs.readFile(fallback, "utf8");
      return contents.split(/\r?\n/)[0].trim();
    })();
  }
  return notionTokenPromise;
}

async function notionFetch(url, { method = "GET", body } = {}) {
  const key = await readToken();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(JSON.stringify({ status: response.status, url, response: json }, null, 2));
  }
  return json;
}

async function searchAll() {
  const results = [];
  let startCursor;
  do {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;
    const page = await notionFetch("https://api.notion.com/v1/search", { method: "POST", body });
    results.push(...(page.results || []));
    startCursor = page.has_more ? page.next_cursor : undefined;
  } while (startCursor);
  return results;
}

async function getDataSource(id) {
  return notionFetch(`https://api.notion.com/v1/data_sources/${id}`);
}

async function queryDataSource(id, maxRows) {
  const rows = [];
  let startCursor;
  do {
    const remaining = Math.max(0, maxRows - rows.length);
    if (remaining === 0) break;
    const body = { page_size: Math.min(100, remaining) };
    if (startCursor) body.start_cursor = startCursor;
    const page = await notionFetch(`https://api.notion.com/v1/data_sources/${id}/query`, { method: "POST", body });
    rows.push(...(page.results || []));
    startCursor = page.has_more ? page.next_cursor : undefined;
  } while (startCursor);
  return rows;
}

function tryParseError(error) {
  try {
    return JSON.parse(String(error?.message || error));
  } catch {
    return null;
  }
}

async function getBlockChildren(id) {
  const blocks = [];
  let startCursor;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (startCursor) qs.set("start_cursor", startCursor);
    const page = await notionFetch(`https://api.notion.com/v1/blocks/${id}/children?${qs.toString()}`);
    blocks.push(...(page.results || []));
    startCursor = page.has_more ? page.next_cursor : undefined;
  } while (startCursor);
  return blocks;
}

function extractBlockText(block) {
  const payload = block?.[block.type];
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload.rich_text)) return joinPlainText(payload.rich_text);
  if (Array.isArray(payload.title)) return joinPlainText(payload.title);
  return "";
}

function normalizePageRow(page) {
  const normalized = {};
  for (const [name, prop] of Object.entries(page.properties || {})) {
    normalized[name] = normalizePropertyValue(prop);
  }
  return {
    id: page.id,
    object: page.object,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: !!page.archived,
    title: extractTitle(page),
    parent: page.parent,
    properties: normalized
  };
}

function pickSummaryColumns(rows) {
  const preferred = ["Task name", "Name", "Status", "Due date", "Assignee"];
  const seen = new Set();
  const columns = [];
  const allNames = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.properties || {})) allNames.add(key);
  }
  for (const key of preferred) {
    if (allNames.has(key) && !seen.has(key)) {
      columns.push(key);
      seen.add(key);
    }
  }
  for (const key of Array.from(allNames).sort()) {
    if (!seen.has(key)) {
      columns.push(key);
      seen.add(key);
    }
    if (columns.length >= 6) break;
  }
  return columns.slice(0, 6);
}

function formatCell(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return truncate(value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", "), 80);
  if (typeof value === "object" && value.start) {
    return truncate(value.end ? `${value.start} -> ${value.end}` : String(value.start), 80);
  }
  if (typeof value === "object") return truncate(JSON.stringify(value), 80);
  return truncate(String(value), 80);
}

function renderTable(columns, rows) {
  if (!rows.length || !columns.length) return "_No rows synced._\n";
  const header = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${columns.map((column) => formatCell(row.properties[column] ?? (column === "Title" ? row.title : ""))).join(" | ")} |`)
    .join("\n");
  return `${header}\n${body}\n`;
}

async function cleanupStagingDirs(root, keep = 2) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const stagingDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of stagingDirs.slice(keep)) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
}

async function atomicWrite(root, buildFn, owner = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staging = path.join(root, `.staging-${timestamp}`);
  const current = path.join(root, "current");
  const previous = path.join(root, ".previous-current");
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(previous, { recursive: true, force: true });
  await ensureDir(staging);
  await applyOwnershipRecursive(staging, owner);
  await buildFn(staging);
  await applyOwnershipRecursive(staging, owner);
  try {
    await fs.rename(current, previous);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(staging, current);
  } catch (error) {
    try {
      await fs.rename(previous, current);
    } catch {
      // best-effort rollback
    }
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true });
  await applyOwnershipRecursive(current, owner);
  await cleanupStagingDirs(root);
}

async function mapWithConcurrency(items, limit, mapper) {
  const bounded = Math.max(1, Number(limit || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(bounded, items.length || 1) }, () => worker()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || "/data/.openclaw/notion-mirror");
  const explicitOwner = parseOwnerSpec(args.owner || process.env.NOTION_MIRROR_OWNER || null);
  const maxDataSourceRows = Number(args["max-data-source-rows"] || 500);
  const concurrency = Math.max(1, Number(args.concurrency || DEFAULT_CONCURRENCY));
  await ensureDir(root);
  const owner = await resolveDesiredOwnership(root, explicitOwner);

  const searchResults = await searchAll();
  const dataSources = searchResults.filter((item) => item.object === "data_source" && !item.in_trash && !item.archived);
  const standalonePages = searchResults.filter(
    (item) => item.object === "page" && item.parent?.type !== "data_source_id"
  );

  await atomicWrite(root, async (staging) => {
    const dsDir = path.join(staging, "data-sources");
    const pageDir = path.join(staging, "pages");
    await ensureDir(dsDir);
    await ensureDir(pageDir);

    const manifest = {
      syncedAt: new Date().toISOString(),
      notionVersion: NOTION_VERSION,
      counts: {
        searchResults: searchResults.length,
        dataSources: dataSources.length,
        standalonePages: standalonePages.length
      },
      dataSources: [],
      standalonePages: []
    };

    const overviewSections = ["# Notion Mirror", "", `Synced at: ${manifest.syncedAt}`, ""];

    const mirroredDataSources = (await mapWithConcurrency(dataSources, concurrency, async (dataSourceStub, index) => {
      let dataSource;
      let rowsRaw;
      try {
        [dataSource, rowsRaw] = await Promise.all([
          getDataSource(dataSourceStub.id),
          queryDataSource(dataSourceStub.id, maxDataSourceRows)
        ]);
      } catch (error) {
        const parsed = tryParseError(error);
        if (parsed?.status === 404 || parsed?.response?.code === "object_not_found") {
          process.stderr.write(`[notion-sync] skipping stale data source ${dataSourceStub.id}\n`);
          return null;
        }
        throw error;
      }
      const rows = rowsRaw.map(normalizePageRow);
      const title = extractTitle(dataSource);
      const slug = `${slugify(title)}-${dataSource.id}`;
      const jsonName = `${slug}.json`;
      const mdName = `${slug}.md`;
      const columns = pickSummaryColumns(rows);
      const summaryMd = [
        `# ${title}`,
        "",
        `- Data source ID: \`${dataSource.id}\``,
        `- Database ID: \`${dataSource.parent?.database_id || dataSource.parent?.data_source_id || ""}\``,
        `- Synced rows: ${rows.length}`,
        `- Last edited: ${dataSource.last_edited_time || ""}`,
        "",
        "## Rows",
        "",
        renderTable(columns, rows)
      ].join("\n");

      const jsonPayload = {
        syncedAt: manifest.syncedAt,
        dataSource: {
          id: dataSource.id,
          title,
          url: dataSource.url || null,
          created_time: dataSource.created_time,
          last_edited_time: dataSource.last_edited_time,
          properties: dataSource.properties || {}
        },
        rows
      };

      await Promise.all([
        fs.writeFile(path.join(dsDir, jsonName), `${JSON.stringify(jsonPayload, null, 2)}\n`),
        fs.writeFile(path.join(dsDir, mdName), `${summaryMd}\n`)
      ]);
      if ((index + 1) % 10 === 0 || index === dataSources.length - 1) {
        process.stderr.write(`[notion-sync] mirrored data sources: ${index + 1}/${dataSources.length}\n`);
      }
      return {
        manifest: {
          id: dataSource.id,
          title,
          rows: rows.length,
          jsonPath: `data-sources/${jsonName}`,
          mdPath: `data-sources/${mdName}`
        },
        overview: [
          `## Data Source: ${title}`,
          "",
          `- ID: \`${dataSource.id}\``,
          `- Rows mirrored: ${rows.length}`,
          `- Summary: \`data-sources/${mdName}\``,
          `- Structured export: \`data-sources/${jsonName}\``,
          ""
        ]
      };
    })).filter(Boolean).sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));

    for (const entry of mirroredDataSources) {
      manifest.dataSources.push(entry.manifest);
      overviewSections.push(...entry.overview);
    }

    const mirroredPages = (await mapWithConcurrency(standalonePages, concurrency, async (page, index) => {
      const title = extractTitle(page);
      const slug = `${slugify(title)}-${page.id}`;
      const blocks = await getBlockChildren(page.id).catch(() => []);
      const blockLines = blocks.map(extractBlockText).filter(Boolean);
      const md = [
        `# ${title}`,
        "",
        `- Page ID: \`${page.id}\``,
        `- URL: ${page.url}`,
        "",
        "## Content",
        "",
        ...(blockLines.length ? blockLines.map((line) => `- ${line}`) : ["_No text blocks mirrored._"])
      ].join("\n");
      await fs.writeFile(path.join(pageDir, `${slug}.md`), `${md}\n`);
      if ((index + 1) % 10 === 0 || index === standalonePages.length - 1) {
        process.stderr.write(`[notion-sync] mirrored pages: ${index + 1}/${standalonePages.length}\n`);
      }
      return {
        manifest: {
          id: page.id,
          title,
          mdPath: `pages/${slug}.md`
        },
        overview: [
          `## Page: ${title}`,
          "",
          `- ID: \`${page.id}\``,
          `- Mirror: \`pages/${slug}.md\``,
          ""
        ]
      };
    })).sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));

    for (const entry of mirroredPages) {
      manifest.standalonePages.push(entry.manifest);
      overviewSections.push(...entry.overview);
    }

    await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(staging, "overview.md"), `${overviewSections.join("\n")}\n`);
  }, owner);

  console.log(
    JSON.stringify(
      {
        ok: true,
        root,
        current: path.join(root, "current"),
        concurrency,
        owner: owner ? `${owner.uid}:${owner.gid}` : null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
