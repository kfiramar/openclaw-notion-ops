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
- keeps a local append-only completion history for archived tasks
- provides higher-level maintenance commands like:
  - `close-day`
  - `show-completed`
  - `triage-inbox`
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
- `show --view today|week|month|year|inbox|blocked|needs_scheduling|execution|calendar`
- `inspect-task --match "..." | --page-id <PAGE_ID>`
- `add-task --title "..." [--horizon today|this week|this month|this year]`
- `move-task --match "..." | --page-id <PAGE_ID> [--horizon ...] [--stage ...]`
- `promote --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year`
- `defer --match "..." | --page-id <PAGE_ID> --to today|this week|this month|this year`
- `block-task --match "..." | --page-id <PAGE_ID> --reason "..."`
- `complete-task --match "..." | --page-id <PAGE_ID> [--when YYYY-MM-DD] [--archive false]`
- `set-schedule --match "..." | --page-id <PAGE_ID> --start ISO --end ISO`
- `list-projects`
- `list-goals`
- `sync`

Maintenance commands:

- `show-completed [--date today|YYYY-MM-DD]`
- `close-day [--date YYYY-MM-DD] [--carry-to this week|this month|this year]`
- `triage-inbox [--date YYYY-MM-DD] [--limit N] [--apply]`
- `review-stale [--date today|YYYY-MM-DD] [--miss-threshold N] [--blocked-days N]`
- `reconcile-calendar [--apply-clear-stale]`

## Completion history

Completed tasks are logged under:

```text
history/completions/YYYY-MM-DD.jsonl
```

This lets active tasks disappear from Notion views while still preserving a durable local memory surface.

## Notes

- `reconcile-calendar` currently validates Notion-side calendar state only. It does not inspect Google Calendar directly.
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
