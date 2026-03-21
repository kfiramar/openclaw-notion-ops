#!/usr/bin/env node

import {
  cmdCapture,
  cmdAddTask,
  cmdBlockTask,
  cmdCompleteTask,
  cmdDefer,
  cmdInspectTask,
  cmdListGoals,
  cmdListProjects,
  cmdMoveTask,
  cmdPromote,
  cmdSetSchedule,
  cmdShow,
  cmdSync
} from "./src/commands.mjs";
import {
  cmdCloseDay,
  cmdReconcileCalendar,
  cmdReviewStale,
  cmdShowCompleted,
  cmdTriageInbox
} from "./src/maintenance.mjs";
import { parseArgs } from "./src/util.mjs";

const COMMANDS = {
  show: {
    help: "show --view today|week|month|year|inbox|blocked|needs_scheduling|execution|calendar",
    run: cmdShow
  },
  "show-completed": {
    help: "show-completed [--date today|YYYY-MM-DD]",
    run: cmdShowCompleted
  },
  capture: {
    help: 'capture --title "..." [--project "..."] [--goal "..."] [--due-date YYYY-MM-DD] [--estimated-minutes N]',
    run: cmdCapture
  },
  "close-day": {
    help: "close-day [--date YYYY-MM-DD] [--carry-to this week|this month|this year]",
    run: cmdCloseDay
  },
  "triage-inbox": {
    help: "triage-inbox [--date YYYY-MM-DD] [--limit N] [--apply]",
    run: cmdTriageInbox
  },
  "reconcile-calendar": {
    help: "reconcile-calendar [--apply-clear-stale]",
    run: cmdReconcileCalendar
  },
  "review-stale": {
    help: "review-stale [--date today|YYYY-MM-DD] [--miss-threshold N] [--blocked-days N]",
    run: cmdReviewStale
  },
  "inspect-task": {
    help: 'inspect-task --match "..." | --page-id <PAGE_ID>',
    run: cmdInspectTask
  },
  "add-task": {
    help: 'add-task --title "..." [--horizon today|this week|this month|this year] [--project "..."] [--project-id <ID>] [--goal "..."] [--goal-id <ID>]',
    run: cmdAddTask
  },
  "move-task": {
    help: 'move-task --match "..." | --page-id <PAGE_ID> [--horizon ...] [--stage ...] [--due-date YYYY-MM-DD]',
    run: cmdMoveTask
  },
  promote: {
    help: 'promote --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year',
    run: cmdPromote
  },
  defer: {
    help: 'defer --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year [--increment-miss]',
    run: cmdDefer
  },
  "block-task": {
    help: 'block-task --match "..." | --page-id <PAGE_ID> --reason "..."',
    run: cmdBlockTask
  },
  "complete-task": {
    help: 'complete-task --match "..." | --page-id <PAGE_ID> [--when YYYY-MM-DD] [--archive false]',
    run: cmdCompleteTask
  },
  "set-schedule": {
    help: 'set-schedule --match "..." | --page-id <PAGE_ID> --start ISO --end ISO [--schedule-type hard|soft]',
    run: cmdSetSchedule
  },
  "list-projects": {
    help: "list-projects",
    run: cmdListProjects
  },
  "list-goals": {
    help: "list-goals",
    run: cmdListGoals
  },
  sync: {
    help: "sync",
    run: cmdSync
  }
};

function printHelp(exitCode = 0) {
  const lines = Object.entries(COMMANDS).map(([, spec]) => `  ${spec.help}`);
  console.log(`notion-board-ops

Commands:
${lines.join("\n")}`);
  process.exit(exitCode);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(0);
  }
  const args = parseArgs(rest);

  const spec = COMMANDS[command];
  if (!spec) printHelp(1);

  try {
    spec.run(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

main();
