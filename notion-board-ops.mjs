#!/usr/bin/env node

import {
  cmdCapture,
  cmdAddTask,
  cmdDeleteTask,
  cmdArchiveTask,
  cmdBlockTask,
  cmdCompleteTask,
  cmdDefer,
  cmdFindTask,
  cmdInspectTask,
  cmdLinkSchedule,
  cmdListGoals,
  cmdListProjects,
  cmdMoveTask,
  cmdPromote,
  cmdRemoveSchedule,
  cmdRescheduleTask,
  cmdSetSchedule,
  cmdSetMultiSchedule,
  cmdSetSeriesSchedule,
  cmdShow,
  cmdSearchTasks,
  cmdSync,
  cmdUnlinkSchedule,
  cmdVerifyTask,
  cmdVerifySchedule
} from "./src/commands.mjs";
import {
  cmdApplyEodPollResults,
  cmdBuildEodPoll,
  cmdListEodPollCandidates,
  cmdProcessEodPolls,
  cmdSendEodPoll
} from "./src/eod-poll.mjs";
import {
  cmdProcessTelegramPollReplies,
  cmdReadTelegramPoll,
  cmdSendTelegramPoll
} from "./src/telegram-poll.mjs";
import {
  cmdAm,
  cmdEp,
  cmdEw,
  cmdLp,
  cmdMo,
  cmdMs,
  cmdPm,
  cmdPw,
  cmdRc,
  cmdWk,
  cmdWs,
  cmdYr
} from "./src/workflows.mjs";
import {
  cmdCloseDay,
  cmdEveningSummary,
  cmdRefreshManualRepeat,
  cmdGoalReview,
  cmdPlanDay,
  cmdTomorrowPlan,
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
  reconcile: {
    help: "reconcile [--no-apply] [--no-sync] [--full]",
    run: cmdRc
  },
  "morning-plan": {
    help: "morning-plan [--date today|YYYY-MM-DD] [--days N] [--limit N] [--plan-limit N] [--decision-limit N] [--no-apply]",
    run: cmdAm
  },
  "morning-sweep": {
    help: "morning-sweep [--date today|YYYY-MM-DD] [--days N] [--limit N] [--no-apply] [--no-sync] [--full]",
    run: cmdMs
  },
  evening: {
    help: "evening [--date today|YYYY-MM-DD] [--days N] [--task-limit N] [--carry-to this week|this month|this year] [--json]",
    run: cmdPm
  },
  "eod-poll": {
    help: "eod-poll [--date today|YYYY-MM-DD] [--account bot4] [--target 492482728] [--carry-to this week|this month|this year] [--close-after-seconds 60] [--expire-after-seconds 43200] [--watch|--watch-seconds N] [--watch-interval-seconds N] [--dry-run]",
    run: cmdEp
  },
  "eod-watch": {
    help: "eod-watch [--batch-id <BATCH_ID>] [--carry-to this week] [--now ISO] [--no-apply]",
    run: cmdEw
  },
  "poll-watch": {
    help: "poll-watch [--poll-id <POLL_ID>] [--account bot4]",
    run: cmdPw
  },
  "weekly-review": {
    help: "weekly-review [--date today|YYYY-MM-DD] [--days N] [--limit N] [--no-apply] [--no-sync] [--full]",
    run: cmdWk
  },
  "weekly-sweep": {
    help: "weekly-sweep [--date today|YYYY-MM-DD] [--days N] [--limit N] [--no-apply] [--no-sync] [--full]",
    run: cmdWs
  },
  "priority-review": {
    help: "priority-review [--date today|YYYY-MM-DD]",
    run: cmdLp
  },
  "monthly-review": {
    help: "monthly-review [--date today|YYYY-MM-DD]",
    run: cmdMo
  },
  "yearly-review": {
    help: "yearly-review",
    run: cmdYr
  },
  show: {
    help: "show --view today|week|month|year|inbox|blocked|overdue|needs_scheduling|execution|calendar",
    run: cmdShow
  },
  "show-completed": {
    help: "show-completed [--date today|YYYY-MM-DD]",
    run: cmdShowCompleted
  },
  "list-eod-poll-candidates": {
    help: "list-eod-poll-candidates [--date today|YYYY-MM-DD]",
    run: cmdListEodPollCandidates
  },
  "build-eod-poll": {
    help: "build-eod-poll [--date today|YYYY-MM-DD]",
    run: cmdBuildEodPoll
  },
  "send-eod-poll": {
    help: "send-eod-poll [--date today|YYYY-MM-DD] [--account bot4] [--target 492482728] [--carry-to this week|this month|this year] [--close-after-seconds 60] [--expire-after-seconds 43200] [--watch|--watch-seconds N] [--watch-interval-seconds N] [--dry-run]",
    run: cmdSendEodPoll
  },
  "process-eod-polls": {
    help: "process-eod-polls [--batch-id <BATCH_ID>] [--carry-to this week] [--now ISO] [--no-apply]",
    run: cmdProcessEodPolls
  },
  "apply-eod-poll-results": {
    help: "apply-eod-poll-results [--date today|YYYY-MM-DD] [--selected-page-ids <ID,ID>] [--unselected-page-ids <ID,ID>] [--carry-to this week]",
    run: cmdApplyEodPollResults
  },
  "send-telegram-poll": {
    help: 'send-telegram-poll --question "..." --options "Option 1|Option 2|Option 3" [--account bot4] [--target 492482728] [--multiple true|false] [--notify-on-answer true|false]',
    run: cmdSendTelegramPoll
  },
  "read-telegram-poll": {
    help: "read-telegram-poll [--poll-id <POLL_ID>] [--account bot4]",
    run: cmdReadTelegramPoll
  },
  "process-telegram-poll-replies": {
    help: "process-telegram-poll-replies [--poll-id <POLL_ID>] [--account bot4]",
    run: cmdProcessTelegramPollReplies
  },
  "evening-summary": {
    help: "evening-summary [--date today|YYYY-MM-DD] [--days N] [--task-limit N]",
    run: cmdEveningSummary
  },
  capture: {
    help: 'capture --title "..." [--project "..."] [--goal "..."] [--horizon today|this week|this month|this year] [--due-date YYYY-MM-DD] [--start ISO --end ISO] [--cadence daily|weekly|monthly] [--repeat-mode none|cadence|manual_repeat|goal_derived] [--repeat-window week|month|year] [--repeat-target-count N] [--repeat-days "Sunday,Monday,..."] [--needs-calendar true|false] [--scheduling-mode hard_time|flexible_block|routine_window|list_only] [--schedule-type hard|soft] [--estimated-minutes N] [--allow-duplicate true]',
    run: cmdCapture
  },
  "plan-day": {
    help: "plan-day [--date today|YYYY-MM-DD] [--limit N] [--start-hour H] [--end-hour H]",
    run: cmdPlanDay
  },
  "tomorrow-plan": {
    help: "tomorrow-plan [--date tomorrow|YYYY-MM-DD] [--days N] [--limit N]",
    run: cmdTomorrowPlan
  },
  "plan-week": {
    help: "plan-week [--date today|YYYY-MM-DD] [--promote-limit N] [--capacity-minutes N]",
    run: cmdPlanWeek
  },
  "close-day": {
    help: "close-day [--page-id <PAGE_ID>] [--date YYYY-MM-DD] [--carry-to this week|this month|this year]",
    run: cmdCloseDay
  },
  "refresh-manual-repeat": {
    help: "refresh-manual-repeat [--page-id <PAGE_ID>] [--date today|YYYY-MM-DD] [--apply]",
    run: cmdRefreshManualRepeat
  },
  "triage-inbox": {
    help: "triage-inbox [--page-id <PAGE_ID>] [--date YYYY-MM-DD] [--limit N] [--apply]",
    run: cmdTriageInbox
  },
  "reconcile-calendar": {
    help: "reconcile-calendar [--page-id <PAGE_ID>] [--apply-clear-stale] [--apply-link-matches]",
    run: cmdReconcileCalendar
  },
  "schedule-sweep": {
    help: "schedule-sweep [--page-id <PAGE_ID>] [--date today|YYYY-MM-DD] [--days N] [--limit N] [--max-daily-minutes N] [--apply] [--apply-hard-time]",
    run: cmdScheduleSweep
  },
  "scheduling-decisions": {
    help: "scheduling-decisions [--page-id <PAGE_ID>] [--date today|tomorrow|YYYY-MM-DD] [--days N] [--limit N]",
    run: cmdSchedulingDecisions
  },
  "review-stale": {
    help: "review-stale [--page-id <PAGE_ID>] [--date today|YYYY-MM-DD] [--miss-threshold N] [--blocked-days N]",
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
  "find-task": {
    help: 'find-task --page-id <PAGE_ID> | --title-exact "..." | --match "..." [--first|--latest] [--include-archived]',
    run: cmdFindTask
  },
  "search-tasks": {
    help: 'search-tasks --page-id <PAGE_ID> | --title-exact "..." | --match "..." [--first|--latest] [--include-archived]',
    run: cmdSearchTasks
  },
  "add-task": {
    help: 'add-task --title "..." [--horizon today|this week|this month|this year] [--project "..."] [--project-id <ID>] [--goal "..."] [--goal-id <ID>] [--cadence daily|weekly|monthly] [--repeat-mode none|cadence|manual_repeat|goal_derived] [--repeat-window week|month|year] [--repeat-target-count N] [--repeat-days "Sunday,Monday,..."] [--needs-calendar true|false] [--scheduling-mode hard_time|flexible_block|routine_window|list_only] [--allow-duplicate true]',
    run: cmdAddTask
  },
  "move-task": {
    help: 'move-task --match "..." | --page-id <PAGE_ID> [--horizon ...] [--stage ...] [--due-date YYYY-MM-DD] [--scheduled-start ISO|YYYY-MM-DD] [--scheduled-end ISO|YYYY-MM-DD] [--needs-calendar true|false] [--scheduling-mode ...] [--schedule-type hard|soft]',
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
  "archive-task": {
    help: 'archive-task --match "..." | --page-id <PAGE_ID> [--all-matches]',
    run: cmdArchiveTask
  },
  "delete-task": {
    help: 'delete-task --match "..." | --page-id <PAGE_ID> [--all-matches] [--allow-recurring]',
    run: cmdDeleteTask
  },
  "set-schedule": {
    help: 'set-schedule --match "..." | --page-id <PAGE_ID> --start ISO|YYYY-MM-DD [--end ISO|YYYY-MM-DD] [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdSetSchedule
  },
  "set-series-schedule": {
    help: 'set-series-schedule --match "..." | --page-id <PAGE_ID> --from-date YYYY-MM-DD --to-date YYYY-MM-DD --days "Monday,Tuesday" --start-time HH:MM --end-time HH:MM [--time-zone Asia/Jerusalem] [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdSetSeriesSchedule
  },
  "set-multi-schedule": {
    help: 'set-multi-schedule --match "..." | --page-id <PAGE_ID> --slots "START|END;START|END" [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdSetMultiSchedule
  },
  "link-schedule": {
    help: 'link-schedule --match "..." | --page-id <PAGE_ID> --event-id <EVENT_ID> --start ISO|YYYY-MM-DD [--end ISO|YYYY-MM-DD] [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
    run: cmdLinkSchedule
  },
  "unlink-schedule": {
    help: 'unlink-schedule --match "..." | --page-id <PAGE_ID>',
    run: cmdUnlinkSchedule
  },
  "verify-schedule": {
    help: 'verify-schedule --match "..." | --page-id <PAGE_ID>',
    run: cmdVerifySchedule
  },
  "verify-task": {
    help: 'verify-task --match "..." | --page-id <PAGE_ID> [--archived true|false] [--scheduled true|false] [--linked true|false] [--stage ...] [--status ...] [--horizon ...] [--schedule-state ...] [--schedule-synced true|false] [--calendar-event-status ...] [--prior-event-id <EVENT_ID>]',
    run: cmdVerifyTask
  },
  "remove-schedule": {
    help: 'remove-schedule --match "..." | --page-id <PAGE_ID> [--all-matches] [--status todo] [--stage planned|active|blocked|inbox]',
    run: cmdRemoveSchedule
  },
  "reschedule-task": {
    help: 'reschedule-task --match "..." | --page-id <PAGE_ID> --start ISO|YYYY-MM-DD [--end ISO|YYYY-MM-DD] [--schedule-type hard|soft] [--scheduling-mode hard_time|flexible_block|routine_window|list_only]',
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
    help: "sync [--full] [--wait-ms N]",
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(0);
  }
  const args = parseArgs(rest);

  const spec = COMMANDS[command];
  if (!spec) printHelp(1);

  try {
    await spec.run(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

await main();
