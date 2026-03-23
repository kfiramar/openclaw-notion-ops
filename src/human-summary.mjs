const SYNTHETIC_TITLE_RE = /\be2e\b/i;
const ROUTINE_SUMMARY_TITLE_RE = /\b(?:daily|weekly|monthly|yearly)\s+overview\s+with\s+openclaw\b/i;

const COMPACT_TITLE_MAP = new Map([
  ["Define what Notion still needs", "define Notion"],
  ["Create workout plan", "workout plan"],
  ["Break startup work into weekly and daily tasks", "startup breakdown"],
  ["Break envctl work into weekly and daily tasks", "envctl breakdown"],
  ["Daily meeting in my 9 to 5", "daily meeting"],
  ["Life priority meeting with OpenClaw", "life priority meeting"],
  ["envctl weekly planning", "envctl weekly planning"],
  ["Startup weekly planning", "startup weekly planning"],
  ["Startup work blocks this week", "startup work"],
  ["envctl work blocks this week", "envctl work"],
  ["Workout this week", "workout this week"],
  ["Coffee with friends this week", "coffee with friends"],
  ["Call my parents", "call my parents"],
  ["Pick up post", "pick up post"],
  ["Meal prepping", "Meal prepping"],
  ["sam lee", "sam lee"]
]);

export function isSyntheticTaskLike(taskOrTitle) {
  const title = typeof taskOrTitle === "string" ? taskOrTitle : taskOrTitle?.title || "";
  return SYNTHETIC_TITLE_RE.test(title);
}

export function isRoutineSummaryTask(taskOrTitle) {
  const title = typeof taskOrTitle === "string" ? taskOrTitle : taskOrTitle?.title || "";
  return ROUTINE_SUMMARY_TITLE_RE.test(title);
}

export function includeInHumanSummary(taskOrTitle) {
  return !isSyntheticTaskLike(taskOrTitle) && !isRoutineSummaryTask(taskOrTitle);
}

export function compactTaskLabel(taskOrTitle) {
  const title = typeof taskOrTitle === "string" ? taskOrTitle : taskOrTitle?.title || "";
  if (!title) return "task";
  if (COMPACT_TITLE_MAP.has(title)) return COMPACT_TITLE_MAP.get(title);

  let label = title
    .replace(/\s+with OpenClaw$/i, "")
    .replace(/\s+this week$/i, "")
    .replace(/\s+blocks$/i, "")
    .trim();

  if (/^[A-Z]/.test(label) && label !== label.toUpperCase()) {
    label = label[0].toLowerCase() + label.slice(1);
  }
  return label;
}
