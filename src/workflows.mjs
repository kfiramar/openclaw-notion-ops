import { cmdShow, cmdSync, cmdListGoals, cmdListProjects } from "./commands.mjs";
import { cmdProcessEodPolls, cmdSendEodPoll } from "./eod-poll.mjs";
import {
  cmdCloseDay,
  cmdEveningSummary,
  cmdPlanDay,
  cmdRefreshManualRepeat,
  cmdReconcileCalendar,
  cmdReviewStale,
  cmdScheduleSweep,
  cmdSchedulingDecisions,
  cmdTriageInbox
} from "./maintenance.mjs";
import { cmdProcessTelegramPollReplies } from "./telegram-poll.mjs";

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1" || value === "yes") return true;
  if (value === false || value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

async function captureStep(step, run, args = {}) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => {
    logs.push(parts.map((part) => (typeof part === "string" ? part : String(part))).join(" "));
  };

  try {
    await run(args);
  } finally {
    console.log = originalLog;
  }

  const text = logs.join("\n").trim();
  let output = text;
  if (text) {
    try {
      output = JSON.parse(text);
    } catch {
      output = text;
    }
  }

  return { step, args, output };
}

async function runJsonWorkflow(action, steps) {
  emitJson({
    ok: true,
    action,
    steps
  });
}

export async function cmdRc(args) {
  const apply = !parseBoolean(args["no-apply"], false);
  const sync = !parseBoolean(args["no-sync"], false);
  const steps = [
    await captureStep("reconcile-calendar", cmdReconcileCalendar, {
      ...(apply ? { "apply-clear-stale": true, "apply-link-matches": true } : {})
    })
  ];
  if (sync) {
    steps.push(await captureStep("sync", cmdSync, { ...(args.full === true ? { full: true } : {}) }));
  }
  await runJsonWorkflow("reconcile", steps);
}

export async function cmdAm(args) {
  const apply = !parseBoolean(args["no-apply"], false);
  const date = args.date || "today";
  const days = args.days || 3;
  const steps = [
    await captureStep("refresh-manual-repeat", cmdRefreshManualRepeat, {
      date,
      ...(apply ? { apply: true } : {})
    }),
    await captureStep("triage-inbox", cmdTriageInbox, {
      date,
      ...(apply ? { apply: true } : {})
    }),
    await captureStep("schedule-sweep", cmdScheduleSweep, {
      date,
      days,
      limit: args.limit || 8,
      ...(apply ? { "apply-hard-time": true } : {})
    }),
    await captureStep("plan-day", cmdPlanDay, {
      date,
      ...(args["plan-limit"] ? { limit: args["plan-limit"] } : {})
    }),
    await captureStep("scheduling-decisions", cmdSchedulingDecisions, {
      date,
      days,
      limit: args["decision-limit"] || 12
    })
  ];
  await runJsonWorkflow("morning-plan", steps);
}

export async function cmdMs(args) {
  const apply = !parseBoolean(args["no-apply"], false);
  const sync = !parseBoolean(args["no-sync"], false);
  const date = args.date || "today";
  const steps = [
    await captureStep("reconcile-calendar", cmdReconcileCalendar, {
      ...(apply ? { "apply-clear-stale": true, "apply-link-matches": true } : {})
    }),
    await captureStep("schedule-sweep", cmdScheduleSweep, {
      date,
      days: args.days || 3,
      limit: args.limit || 8,
      ...(apply ? { "apply-hard-time": true } : {})
    })
  ];
  if (sync) {
    steps.push(await captureStep("sync", cmdSync, { ...(args.full === true ? { full: true } : {}) }));
  }
  await runJsonWorkflow("morning-sweep", steps);
}

export async function cmdPm(args) {
  const date = args.date || "today";
  const closeDay = await captureStep("close-day", cmdCloseDay, {
    date,
    ...(args["carry-to"] ? { "carry-to": args["carry-to"] } : {})
  });
  const summary = await captureStep("evening-summary", cmdEveningSummary, {
    date,
    days: args.days || 3,
    "task-limit": args["task-limit"] || 4
  });
  if (args.json === true) {
    emitJson({
      ok: true,
      action: "evening",
      close_day: closeDay.output,
      summary: summary.output
    });
    return;
  }
  console.log(typeof summary.output === "string" ? summary.output : JSON.stringify(summary.output, null, 2));
}

export async function cmdEp(args) {
  await cmdSendEodPoll({
    date: args.date || "today",
    ...(args.account ? { account: args.account } : {}),
    ...(args.target ? { target: args.target } : {}),
    ...(args["carry-to"] ? { "carry-to": args["carry-to"] } : {}),
    ...(args["close-after-seconds"] ? { "close-after-seconds": args["close-after-seconds"] } : {}),
    ...(args["expire-after-seconds"] ? { "expire-after-seconds": args["expire-after-seconds"] } : {}),
    ...(args.watch !== undefined ? { watch: args.watch } : {}),
    ...(args["watch-seconds"] ? { "watch-seconds": args["watch-seconds"] } : {}),
    ...(args["watch-interval-seconds"] ? { "watch-interval-seconds": args["watch-interval-seconds"] } : {}),
    ...(args["dry-run"] === true ? { "dry-run": true } : {})
  });
}

export async function cmdEw(args) {
  await cmdProcessEodPolls({
    "batch-id": args["batch-id"],
    "carry-to": args["carry-to"] || "this week",
    ...(args.now ? { now: args.now } : {}),
    ...(args["no-apply"] === true ? { "no-apply": true } : {})
  });
}

export async function cmdPw(args) {
  await cmdProcessTelegramPollReplies({
    ...(args["poll-id"] ? { "poll-id": args["poll-id"] } : {}),
    ...(args.account ? { account: args.account } : {})
  });
}

export async function cmdWk(args) {
  const apply = !parseBoolean(args["no-apply"], false);
  const sync = !parseBoolean(args["no-sync"], false);
  const date = args.date || "today";
  const steps = [
    await captureStep("refresh-manual-repeat", cmdRefreshManualRepeat, {
      date,
      ...(apply ? { apply: true } : {})
    })
  ];
  if (sync) {
    steps.push(await captureStep("sync", cmdSync, { ...(args.full === true ? { full: true } : {}) }));
  }
  steps.push(
    await captureStep("show-week", cmdShow, { view: "week" }),
    await captureStep("scheduling-decisions", cmdSchedulingDecisions, {
      date,
      days: args.days || 7,
      limit: args.limit || 16
    })
  );
  await runJsonWorkflow("weekly-review", steps);
}

export async function cmdWs(args) {
  const apply = !parseBoolean(args["no-apply"], false);
  const sync = !parseBoolean(args["no-sync"], false);
  const date = args.date || "today";
  const steps = [
    await captureStep("reconcile-calendar", cmdReconcileCalendar, {
      ...(apply ? { "apply-clear-stale": true, "apply-link-matches": true } : {})
    }),
    await captureStep("schedule-sweep", cmdScheduleSweep, {
      date,
      days: args.days || 7,
      limit: args.limit || 12,
      ...(apply ? { "apply-hard-time": true } : {})
    })
  ];
  if (sync) {
    steps.push(await captureStep("sync", cmdSync, { ...(args.full === true ? { full: true } : {}) }));
  }
  await runJsonWorkflow("weekly-sweep", steps);
}

export async function cmdLp(args) {
  const date = args.date || "today";
  const steps = [
    await captureStep("review-stale", cmdReviewStale, { date }),
    await captureStep("show-week", cmdShow, { view: "week" })
  ];
  await runJsonWorkflow("priority-review", steps);
}

export async function cmdMo(args) {
  const date = args.date || "today";
  const steps = [
    await captureStep("show-month", cmdShow, { view: "month" }),
    await captureStep("review-stale", cmdReviewStale, { date }),
    await captureStep("list-projects", cmdListProjects, {}),
    await captureStep("list-goals", cmdListGoals, {})
  ];
  await runJsonWorkflow("monthly-review", steps);
}

export async function cmdYr() {
  const steps = [
    await captureStep("show-year", cmdShow, { view: "year" }),
    await captureStep("list-goals", cmdListGoals, {})
  ];
  await runJsonWorkflow("yearly-review", steps);
}
