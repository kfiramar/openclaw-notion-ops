# openclaw-notion-ops

Generic local CLI for operating a Notion-backed task board from a mirror-first workflow.

This repo was extracted from a working OpenClaw Lifestyle board wrapper and generalized so it can be reused without carrying personal IDs, URLs, or machine-specific paths.

For your current machine, the intended model is:

- edit and version code here
- sync the generated live wrapper into the OpenClaw workspace
- do not hand-edit the deployed copy unless you intend to port that change back

## What it does

- reads tasks, projects, and goals from a local Notion mirror
- writes through a Notion API CLI running inside an OpenClaw container
- triggers a background mirror refresh after writes
- avoids stacking duplicate mirror-sync workers when a sync is already running
- keeps a local append-only completion history for archived tasks
- uses a fast board-only sync path by default for task/project/goal mirrors
- provides higher-level maintenance commands like:
  - `close-day`
  - `show-completed`
  - `triage-inbox`
  - `scheduling-decisions`
  - `reconcile-calendar`

## Requirements

- Node 18+
- Docker
- an OpenClaw container with:
  - `notion-api`
  - `notion-local-mirror`
- a board registry file describing your task/project/goal data sources

## Setup

1. Copy the example registry:

```bash
cp examples/LIFESTYLE_BOARD.example.json board.json
```

2. Edit `board.json` with your own data source IDs and mirror file paths.

3. Optionally override runtime settings with environment variables:

```bash
export OPENCLAW_CONTAINER="openclaw-pma3-openclaw-1"
export NOTION_API_PATH="/data/.openclaw/skills/notion-api/scripts/notion-api.mjs"
export NOTION_MIRROR_ROOT="/data/.openclaw/notion-mirror"
export NOTION_MIRROR_SYNC="/data/.openclaw/skills/notion-local-mirror/scripts/notion-sync.mjs"
export BOARD_PATH="/abs/path/to/board.json"
export HISTORY_ROOT="/abs/path/to/history"
```

## Keeping OpenClaw In Sync

Use the repo as the source of truth, then regenerate the live wrapper:

```bash
npm run sync:openclaw
```

Check whether the live workspace has drifted:

```bash
npm run check:openclaw
```

See the raw differences:

```bash
npm run diff:openclaw
```

By default the sync target is:

```text
/docker/openclaw-pma3/data/.openclaw/workspace-personal
```

You can override it:

```bash
OPENCLAW_WORKSPACE=/some/other/workspace npm run sync:openclaw
```

## Commands

```bash
node notion-board-ops.mjs
```

Core commands:

- `capture --title "..." [--project "..."] [--goal "..."] [--due-date YYYY-MM-DD]`
  - if `--start` and `--end` are supplied, the wrapper now creates the matching Google Calendar event and stores the event ID alongside the Notion schedule fields
- `plan-day [--date today|YYYY-MM-DD] [--limit N] [--start-hour H] [--end-hour H]`
- `plan-week [--date today|YYYY-MM-DD] [--promote-limit N] [--capacity-minutes N]`
- `show --view today|week|month|year|inbox|blocked|needs_scheduling|execution|calendar`
- `inspect-task --match "..." | --page-id <PAGE_ID>`
- `add-task --title "..." [--horizon today|this week|this month|this year]`
- `move-task --match "..." | --page-id <PAGE_ID> [--horizon ...] [--stage ...]`
- `promote --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year`
- `defer --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year`
- `block-task --match "..." | --page-id <PAGE_ID> --reason "..."`
- `complete-task --match "..." | --page-id <PAGE_ID> [--when YYYY-MM-DD] [--archive false]`
- `set-schedule --match "..." | --page-id <PAGE_ID> --start ISO --end ISO`
- `remove-schedule --match "..." | --page-id <PAGE_ID>`
- `reschedule-task --match "..." | --page-id <PAGE_ID> --start ISO --end ISO`
  - schedule-writing commands reject partial or inverted time ranges instead of writing broken state
- `list-projects`
- `list-goals`
- `project-review [--match "..."] | [--page-id <PAGE_ID>]`
- `goal-review [--match "..."] | [--page-id <PAGE_ID>]`
- `sync [--full]`

Maintenance commands:

- `show-completed [--date today|YYYY-MM-DD]`
- `close-day [--date YYYY-MM-DD] [--carry-to this week|this month|this year]`
- `triage-inbox [--date YYYY-MM-DD] [--limit N] [--apply]`
- `review-stale [--date today|YYYY-MM-DD] [--miss-threshold N] [--blocked-days N]`
- `scheduling-decisions [--date today|tomorrow|YYYY-MM-DD] [--days N] [--limit N]`
- `reconcile-calendar [--apply-clear-stale]`

Board model notes:

- `today` and `this week` can be real child pages
- `this month` and `this year` can be view-backed surfaces rather than standalone pages
- the CLI operates on the task/project/goal data sources and mirror files, so it does not depend on decorative dashboard prose or checklist blocks

## Completion history

Completed tasks are logged under:

```text
history/completions/YYYY-MM-DD.jsonl
```

This lets active tasks disappear from Notion views while still preserving a durable local memory surface.

## Notes

- `sync` is optimized for the configured board databases; use `sync --full` only when you explicitly need the slower whole-workspace mirror.
- `scheduling-decisions` separates unresolved hard-time items from flexible items that should be surfaced conversationally before scheduling.
- `reconcile-calendar` validates Notion-side state and also checks referenced Google Calendar events directly through `gog`.
- The CLI assumes your board uses task properties similar to:
  - `Task Name`
  - `Stage`
  - `Status`
  - `Horizon`
  - `Needs Calendar`
  - `Scheduled Start`
  - `Scheduled End`
  - `Calendar Event ID`

If your schema differs, edit `src/config.mjs`.
