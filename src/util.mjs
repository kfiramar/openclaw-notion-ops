import fs from "node:fs";
import path from "node:path";

export function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function appendJsonLine(file, payload) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
}

export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part.startsWith("--")) {
      const key = part.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(part);
    }
  }
  return args;
}

export function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase();
}

export function joinPlainText(items) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => item?.plain_text || item?.text?.content || "").join("").trim();
}

export function normalizeFormula(formula) {
  if (!formula || typeof formula !== "object") return null;
  return formula[formula.type] ?? null;
}

export function normalizePropertyValue(prop) {
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
    case "date":
      return prop.date ? { start: prop.date.start, end: prop.date.end, time_zone: prop.date.time_zone } : null;
    case "checkbox":
      return !!prop.checkbox;
    case "number":
      return prop.number;
    case "relation":
      return Array.isArray(prop.relation) ? prop.relation.map((item) => item.id) : [];
    case "formula":
      return normalizeFormula(prop.formula);
    default:
      return prop[prop.type] ?? null;
  }
}

export function extractPageTitle(page) {
  const properties = page.properties || {};
  for (const prop of Object.values(properties)) {
    if (prop?.type === "title") return joinPlainText(prop.title);
  }
  return page.id;
}

export function boolOrNull(value) {
  if (value === undefined) return null;
  if (value === true || value === "true" || value === "1" || value === "yes") return true;
  if (value === false || value === "false" || value === "0" || value === "no") return false;
  die(`invalid boolean: ${value}`);
}

export function isoDate(value) {
  if (!value) return null;
  return value;
}

export function titleProperty(value) {
  return {
    title: [{ text: { content: value } }]
  };
}

export function richTextProperty(value) {
  return {
    rich_text: value ? [{ text: { content: value } }] : []
  };
}

export function selectProperty(value) {
  return { select: value ? { name: value } : null };
}

export function checkboxProperty(value) {
  return { checkbox: Boolean(value) };
}

export function numberProperty(value) {
  return { number: value === undefined || value === null ? null : Number(value) };
}

export function dateProperty(start, end = null) {
  return { date: start ? { start, end } : null };
}

export function relationProperty(ids) {
  return {
    relation: (ids || []).map((id) => ({ id }))
  };
}

export function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeDateArg(value) {
  if (!value || value === "today") return nowDate();
  return value;
}

export function addDays(base, days) {
  const value = new Date(`${base}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function monthEnd(base) {
  const value = new Date(`${base}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1, 0);
  return value.toISOString().slice(0, 10);
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
