#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const OPENCLAW = process.env.OPENCLAW_BIN || "openclaw";
const TELEGRAM_TO = process.env.OPENCLAW_TELEGRAM_TO || "492482728";
const TELEGRAM_ACCOUNT = process.env.OPENCLAW_TELEGRAM_ACCOUNT || "bot4";

const JOBS = [
  {
    name: "Lifestyle reconcile",
    description: "Reconcile Lifestyle task lifecycle state in Notion without user-facing delivery",
    schedule: { kind: "every", value: "30m" },
    delivery: { mode: "none" },
    timeoutSeconds: 300,
    thinking: "medium",
    message:
      "Run the Lifestyle productivity reconciliation pass. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, and recent memory. Start with `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs reconcile-calendar --apply-clear-stale --apply-link-matches` and then `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs sync`. Use fresh live reads for Lifestyle Tasks, Projects, and Goals. Keep all changes inside the Lifestyle system only. Archive completed one-time tasks after logging completion if needed. Roll cadence recurring tasks forward by stamping completion, computing the next due date, resetting status, and clearing stale schedule/calendar refs. Preserve manual-repeat rows and keep their progress/window state coherent. Increment Miss Count for missed scheduled unfinished work. If Miss Count reaches 3 or more, add explicit Review Notes calling for intervention. Respect @auto-done and @no-check markers for scheduled tasks that should be treated as reliably completed. Do not send a user-facing message unless a real system problem needs escalation."
  },
  {
    name: "Lifestyle morning plan",
    description: "Daily user-facing morning plan message for the Lifestyle productivity system",
    schedule: { kind: "cron", value: "15 7 * * *", tz: "Asia/Jerusalem" },
    delivery: { mode: "announce", channel: "telegram", to: TELEGRAM_TO, account: TELEGRAM_ACCOUNT },
    timeoutSeconds: 300,
    thinking: "medium",
    message:
      "Run the Lifestyle morning planning routine for Kfir. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, MEMORY.md, and recent memory. Start with `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs refresh-manual-repeat --apply`, `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs triage-inbox --apply`, `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs schedule-sweep --date today --days 3 --limit 8 --apply-hard-time`, `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs plan-day --date today`, and `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs scheduling-decisions --date today --days 3 --limit 12`. Use fresh Notion reads as needed and gog for calendar. For calendar reads here, prefer `gog calendar events suukpehoy@gmail.com --from <ISO> --to <ISO> --json`. Use one final Telegram message only. No workflow narration. Start with `Today tasks:`. Keep it short. Use double-asterisk bold for task labels. Put already-fixed calendar items under `Scheduled:` only. For tasks that still need a decision, use `(NEEDS SCHEDULING)` or `(FREE TIME)` exactly. Before inventing generic time options, prefer `preferred_slots` from `scheduling-decisions`; those are the OpenViking-backed timing suggestions. Only fall back to generic options if no preferred slots exist. Do not silently place flexible work just because there is space."
  },
  {
    name: "Lifestyle scheduling sweep",
    description: "Daily silent hard-time scheduling pass for safe lifestyle tasks",
    schedule: { kind: "cron", value: "45 7 * * *", tz: "Asia/Jerusalem" },
    delivery: { mode: "none" },
    timeoutSeconds: 420,
    thinking: "medium",
    message:
      "Run the Lifestyle scheduling sweep for Kfir. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, and recent memory. Run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs reconcile-calendar --apply-clear-stale --apply-link-matches`, then `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs schedule-sweep --date today --days 3 --limit 8 --apply-hard-time`, then `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs sync`. Auto-place only hard_time items whose intended timing is already explicit from task data. Do not auto-place flexible_block work from this cron. Only send a user-facing message if you actually fixed or moved a hard-time item, or there is a real unresolved system issue. If you send a message, keep it extremely short and action-only."
  },
  {
    name: "Daily overview with OpenClaw",
    description: "Daily evening overview to plan tomorrow for the Lifestyle productivity system",
    schedule: { kind: "cron", value: "30 21 * * *", tz: "Asia/Jerusalem" },
    delivery: { mode: "announce", channel: "telegram", to: TELEGRAM_TO, account: TELEGRAM_ACCOUNT },
    timeoutSeconds: 300,
    thinking: "medium",
    message:
      "Run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs close-day --date today` first. Then run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs evening-summary --date today --days 3 --task-limit 4`. Send Kfir exactly the stdout from the `evening-summary` command and nothing else. Do not add any greeting, intro, explanation, summary line, or formatting changes. If the command fails, report the real failure briefly instead of improvising."
  },
  {
    name: "Lifestyle daily completion poll",
    description: "Nightly Telegram completion poll for today's Lifestyle tasks",
    schedule: { kind: "cron", value: "35 21 * * *", tz: "Asia/Jerusalem" },
    delivery: { mode: "none" },
    timeoutSeconds: 180,
    thinking: "low",
    message:
      "Run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs send-eod-poll --date today --close-after-seconds 60 --expire-after-seconds 43200`. Do not send any extra user-facing message from the agent. The command itself handles Telegram delivery when there are tasks that need confirmation."
  },
  {
    name: "Lifestyle daily completion poll watcher",
    description: "Minute-based watcher that closes and applies nightly Telegram completion polls",
    schedule: { kind: "every", value: "1m" },
    delivery: { mode: "none" },
    timeoutSeconds: 120,
    thinking: "low",
    message:
      "Run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs process-eod-polls --carry-to this week`. Do not send any user-facing message unless the command reports a real system failure that needs escalation."
  },
  {
    name: "Weekly overview with OpenClaw",
    description: "Saturday user-facing weekly overview and next-week planning for the Lifestyle system",
    schedule: { kind: "cron", value: "0 9 * * 6", tz: "Asia/Jerusalem" },
    delivery: { mode: "announce", channel: "telegram", to: TELEGRAM_TO, account: TELEGRAM_ACCOUNT },
    timeoutSeconds: 420,
    thinking: "medium",
    message:
      "Run the Weekly overview with OpenClaw for Kfir on Saturday. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, MEMORY.md, and recent memory. Use fresh Notion reads for Lifestyle Tasks, Projects, and Goals, and inspect Google Calendar for the coming week. For calendar reads here, prefer `gog calendar events suukpehoy@gmail.com --from <ISO> --to <ISO> --json`. Before planning, run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs refresh-manual-repeat --apply`, `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs sync`, `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs show --view week`, and `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs scheduling-decisions --date today --days 7 --limit 16`. Send one final Telegram message only. No workflow narration. Use short action-specific headings only: `Done`, `Needs attention`, `Schedule these`, `Confirm`, `Reply with`. In `Schedule these`, include only work that is actually missing future calendar coverage. For grouped-repeat work, offer exactly the missing number of future sessions, not extra optional spreads. Prefer `preferred_slots` from `scheduling-decisions` before inventing fallback slots."
  },
  {
    name: "Lifestyle weekly scheduling sweep",
    description: "Saturday silent weekly hard-time placement pass after the weekly overview",
    schedule: { kind: "cron", value: "20 9 * * 6", tz: "Asia/Jerusalem" },
    delivery: { mode: "none" },
    timeoutSeconds: 420,
    thinking: "medium",
    message:
      "Run the Lifestyle weekly scheduling sweep for Kfir after the weekly overview. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, and recent memory. Run `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs reconcile-calendar --apply-clear-stale --apply-link-matches`, then `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs schedule-sweep --date today --days 7 --limit 12 --apply-hard-time`, then `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs sync`. Auto-place only hard_time items whose intended timing is already explicit. Do not auto-place flexible_block work from this cron. Only send a user-facing message if you actually fixed or moved a hard-time item, or a real system issue needs escalation."
  },
  {
    name: "Life priority meeting with OpenClaw",
    description: "Weekly direct priority check-in initiated by OpenClaw",
    schedule: { kind: "cron", value: "0 20 * * 0", tz: "Asia/Jerusalem" },
    delivery: { mode: "announce", channel: "telegram", to: TELEGRAM_TO, account: TELEGRAM_ACCOUNT },
    timeoutSeconds: 300,
    thinking: "medium",
    message:
      "Run the Life priority meeting with OpenClaw for Kfir. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, MEMORY.md, and recent memory. Use `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs review-stale`, `node /data/.openclaw/workspace-personal/lifestyle-ops.mjs show --view week`, and fresh reads from Lifestyle Projects and Goals if needed. Send one concise Telegram check-in that names the most important real priorities, the main drift or avoidance pattern if visible, and asks what to protect this week versus consciously deprioritize. Keep it sharp and direct."
  },
  {
    name: "Lifestyle monthly review",
    description: "Monthly review and planning for the Lifestyle system",
    schedule: { kind: "cron", value: "30 9 1 * *", tz: "Asia/Jerusalem" },
    delivery: { mode: "announce", channel: "telegram", to: TELEGRAM_TO, account: TELEGRAM_ACCOUNT },
    timeoutSeconds: 420,
    thinking: "medium",
    message:
      "Run the Lifestyle monthly review and planning routine for Kfir. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, MEMORY.md, and recent memory. Use fresh Notion reads for Lifestyle Tasks, Projects, and Goals and check the upcoming month in Google Calendar when useful. Review accomplishments, misses, carry-over, blocked items, repeated drift, project health, and goal health. Add or adjust next-month planned work only when it is grounded in current task/project state. Send one concise monthly review with the most important adjustments for the new month."
  },
  {
    name: "Lifestyle yearly review",
    description: "Yearly goal review for the Lifestyle system",
    schedule: { kind: "cron", value: "0 10 1 1 *", tz: "Asia/Jerusalem" },
    delivery: { mode: "announce", channel: "telegram", to: TELEGRAM_TO, account: TELEGRAM_ACCOUNT },
    timeoutSeconds: 420,
    thinking: "medium",
    message:
      "Run the Lifestyle yearly review for Kfir. Read SOUL.md, USER.md, PRODUCTIVITY.md, TOOLS.md, MEMORY.md, and recent memory. Use fresh Notion reads for Lifestyle Tasks, Projects, and Goals. Review the current year's goals, achievements, misses, repeated drift, and the project-level work that actually moved the year. Draft the highest-leverage direction for the next year and the first concrete projects or tasks that should follow. Send one concise yearly review only."
  }
];

function execOpenClaw(args) {
  return execFileSync(OPENCLAW, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function listJobs() {
  const stdout = execOpenClaw(["cron", "list", "--json"]);
  return JSON.parse(stdout).jobs || [];
}

function deliveryArgs(job) {
  if (job.delivery.mode === "announce") {
    return [
      "--announce",
      "--channel",
      job.delivery.channel,
      "--to",
      job.delivery.to,
      "--account",
      job.delivery.account
    ];
  }
  return ["--no-deliver", "--channel", "last"];
}

function scheduleArgs(job) {
  if (job.schedule.kind === "every") return ["--every", job.schedule.value];
  return ["--cron", job.schedule.value, "--tz", job.schedule.tz];
}

function upsertArgs(job) {
  return [
    "--name",
    job.name,
    "--description",
    job.description,
    "--agent",
    "personal",
    "--session",
    "isolated",
    "--thinking",
    job.thinking,
    "--timeout-seconds",
    String(job.timeoutSeconds),
    "--message",
    job.message,
    ...scheduleArgs(job),
    ...deliveryArgs(job)
  ];
}

function main() {
  const existingJobs = new Map(listJobs().map((job) => [job.name, job]));
  const updated = [];
  const created = [];

  for (const job of JOBS) {
    const existing = existingJobs.get(job.name);
    if (existing) {
      execOpenClaw(["cron", "edit", existing.id, "--enable", ...upsertArgs(job)]);
      updated.push({ id: existing.id, name: job.name });
    } else {
      const stdout = execOpenClaw(["cron", "add", "--json", ...upsertArgs(job)]);
      const createdJob = JSON.parse(stdout);
      created.push({ id: createdJob.id, name: job.name });
    }
  }

  console.log(JSON.stringify({ ok: true, updated, created, total: JOBS.length }, null, 2));
}

main();
