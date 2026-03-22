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
  cmdRemoveSchedule,
  cmdRescheduleTask,
  cmdSetSchedule,
  cmdShow,
  cmdSync
} from "./src/commands.mjs";
import {
  cmdCloseDay,
  cmdRefreshManualRepeat,
  cmdGoalReview,
  cmdPlanDay,
  cmdPlanWeek,
  cmdProjectReview,
  cmdReconcileCalendar,
  cmdScheduleSweep,
  cmdSchedulingDecisions,
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
    help: 'capture --title "..." [--project "..."] [--goal "..."] [--horizon today|this week|this month|this year] [--due-date YYYY-MM-DD] [--start ISO --end ISO] [--cadence daily|weekly|monthly] [--repeat-mode none|cadence|manual_repeat|goal_derived] [--repeat-window week|month|year] [--repeat-target-count N] [--repeat-days "Sunday,Monday,..."] [--needs-calendar true|false] [--scheduling-mode hard_time|flexible_block|routine_window|list_only] [--schedule-type hard|soft] [--estimated-minutes N]',
    run: cmdCapture
  },
  "plan-day": {
    help: "plan-day [--date today|YYYY-MM-DD] [--limit N] [--start-hour H] [--end-hour H]",
    run: cmdPlanDay
  },
  "plan-week": {
    help: "plan-week [--date today|YYYY-MM-DD] [--promote-limit N] [--capacity-minutes N]",
    run: cmdPlanWeek
  },
  "close-day": {
    help: "close-day [--date YYYY-MM-DD] [--carry-to this week|this month|this year]",
    run: cmdCloseDay
  },
  "refresh-manual-repeat": {
    help: "refresh-manual-repeat [--date today|YYYY-MM-DD] [--apply]",
    run: cmdRefreshManualRepeat
  },
  "triage-inbox": {
    help: "triage-inbox [--date YYYY-MM-DD] [--limit N] [--apply]",
    run: cmdTriageInbox
  },
  "reconcile-calendar": {
    help: "reconcile-calendar [--apply-clear-stale] [--apply-link-matches]",
    run: cmdReconcileCalendar
  },
  "schedule-sweep": {
    help: "schedule-sweep [--date today|YYYY-MM-DD] [--days N] [--limit N] [--max-daily-minutes N] [--apply]",
    run: cmdScheduleSweep
  },
  "scheduling-decisions": {
    help: "scheduling-decisions [--date today|tomorrow|YYYY-MM-DD] [--days N] [--limit N]",
    run: cmdSchedulingDecisions
  },
  "review-stale": {
    help: "review-stale [--date today|YYYY-MM-DD] [--miss-threshold N] [--blocked-days N]",
    run: cmdReviewStale
  },
  "project-review": {
    help: 'project-review [--match "..."] | [--page-id <PAGE_ID>]',
    run: cmdProjectReview
  },
  "goal-review": {
    help: 'goal-review [--match "..."] | [--page-id <PAGE_ID>]',
    run: cmdGoalReview
  },
  "inspect-task": {
    help: 'inspect-task --match "..." | --page-id <PAGE_ID>',
    run: cmdInspectTask
  },
  "add-task": {
    help: 'add-task --title "..." [--horizon today|this week|this month|this year] [--project "..."] [--project-id <ID>] [--goal "..."] [--goal-id <ID>] [--cadence daily|weekly|monthly] [--repeat-mode none|cadence|manual_repeat|goal_derived] [--repeat-window week|month|year] [--repeat-target-count N] [--repeat-days "Sunday,Monday,..."] [--needs-calendar true|false] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdAddTask
  },
  "move-task": {
    help: 'move-task --match "..." | --page-id <PAGE_ID> [--horizon ...] [--stage ...] [--due-date YYYY-MM-DD] [--scheduled-start ISO] [--scheduled-end ISO] [--needs-calendar true|false] [--scheduling-mode ...] [--schedule-type hard|soft]',
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
    help: 'set-schedule --match "..." | --page-id <PAGE_ID> --start ISO --end ISO [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdSetSchedule
  },
  "remove-schedule": {
    help: 'remove-schedule --match "..." | --page-id <PAGE_ID> [--status todo] [--stage planned|active|blocked|inbox]',
    run: cmdRemoveSchedule
  },
  "reschedule-task": {
    help: 'reschedule-task --match "..." | --page-id <PAGE_ID> --start ISO --end ISO [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdRescheduleTask
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
    help: "sync [--full]",
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
