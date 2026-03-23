# Cron And Runtime Fixes

This note documents the fixes that were applied across the Lifestyle wrapper, OpenClaw cron setup, and the live OpenClaw runtime.

## Repo-backed fixes

These changes are tracked in `openclaw-notion-ops` and can be redeployed with:

```bash
npm run sync:openclaw
npm run sync:crons
```

### 1. Memory-backed scheduling suggestions

Files:

- `src/openviking.mjs`
- `src/maintenance.mjs`

What changed:

- Added a lightweight OpenViking client for direct memory lookup from the wrapper repo.
- Added scheduling preference extraction from memory text:
  - weekday patterns
  - weekday ranges
  - exact time ranges
  - coarse dayparts like `morning`, `afternoon`, `evening`
- Wired those preferences into scheduling output so suggested slots prefer remembered patterns before generic fallback windows.

Effect:

- `scheduling-decisions` now returns `preferred_slots` and `preference_summary` for flexible work.
- `evening-summary` now uses remembered timing preferences when composing `Schedule these` suggestions.

### 2. Auto-done aliases for “don’t ask me again” tasks

Files:

- `src/tasks.mjs`

What changed:

- Expanded auto-complete markers in task `Review Notes`.
- Supported markers now include:
  - `@auto-done`
  - `@autodone`
  - `@auto-done-scheduled`
  - `@auto-complete-scheduled`
  - `@no-check`
  - `no check needed`
  - `auto done when scheduled`

Effect:

- Reliable scheduled tasks like a recurring 9-to-5 block can be treated as completed automatically during `close-day`.
- Those tasks no longer need to keep showing up in evening review confirmation prompts when marked this way.

### 3. Async-capable CLI entrypoint

Files:

- `notion-board-ops.mjs`

What changed:

- Converted the CLI entrypoint to await async command handlers.

Effect:

- Async maintenance commands like memory-aware scheduling flows can run correctly from the repo wrapper and the synced OpenClaw workspace wrapper.

### 4. Repo-managed cron definitions

Files:

- `scripts/sync-openclaw-crons.mjs`
- `package.json`
- `README.md`

What changed:

- Added a source-controlled cron sync script for all 9 live Lifestyle/OpenClaw cron jobs.
- Cron prompts now live in repo code instead of only inside `jobs.json`.
- Added npm entrypoints:
  - `npm run sync:crons`
  - `npm run sync:all`

Effect:

- Cron wording, schedules, and delivery behavior are now repeatable and reviewable in git.
- Live cron drift can be corrected by re-running the sync script.

### 5. Cron smoke tooling

Files:

- `scripts/smoke-cron-job.mjs`
- `package.json`
- `README.md`

What changed:

- Added a utility for forcing a named cron run and then reading back persisted history.

Usage:

```bash
npm run smoke:cron -- --name "Daily overview with OpenClaw"
```

Effect:

- Weekly/monthly/yearly jobs can be tested without waiting for wall-clock schedule time.

## Live runtime fixes

These fixes were applied directly to the installed OpenClaw runtime and are currently live, but they are not tracked in this repo because the actual OpenClaw source repository was not available in this workspace.

### 1. Honest cron failure status

Live files patched:

- `/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/gateway-cli-CuZs0RlJ.js`
- `/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/gateway-cli-Ol-vpIk7.js`

What changed:

- Added textual failure detection for cron/manual runs.
- Normalized run status so non-zero command exits are stored as `error` instead of falsely stored as `ok`.
- Adjusted the heuristic to treat `status/code 0` as success and only non-zero exit mentions as failure.

Verified with live smokes:

- deliberate `exit 1` now persists as `status: "error"`
- deliberate `exit 0` now persists as `status: "ok"`

### 2. JSON stdout cleanup for `openclaw cron ... --json`

Live file patched:

- `/docker/openclaw-pma3/data/.openclaw/extensions/openviking/index.ts`

What changed:

- Moved the OpenViking “registered context-engine” startup line off stdout.

Effect:

- `openclaw cron list --json | jq ...` works again.
- JSON stdout is no longer polluted by the plugin registration banner.

## Operational fixes applied during debugging

### 1. Notion mirror permission repair

What changed:

- Fixed ownership for the live Notion mirror tree so the OpenClaw runtime user could write sync output.

Effect:

- Wrapper `sync` stopped failing from mirror write permission issues.

### 2. Doctor config normalization

What changed:

- Ran `openclaw doctor --fix`.

Effect:

- Reduced repeated config migration noise and normalized live OpenClaw config layout.

## Current remaining gaps

### 1. OpenClaw runtime hotfixes are still live-only

The gateway cron-status fix exists only in the installed runtime bundle right now.

To persist it properly:

- get the real OpenClaw source repo into the workspace
- apply the same logic there
- build/redeploy OpenClaw from source

### 2. Loopback handshake timeouts still appear intermittently

Observed issue:

- rapid back-to-back `openclaw cron ...` CLI calls can still occasionally fail with gateway loopback handshake timeout / close behavior

Status:

- not fixed in this pass
- should be handled in the actual OpenClaw source repo, not in the Lifestyle wrapper repo

### 3. Cron prompts are now source-controlled, but the scheduler itself still depends on manual sync

Current source of truth:

- repo: `scripts/sync-openclaw-crons.mjs`

Current deployment step:

```bash
npm run sync:crons
```

Future improvement:

- integrate cron sync into a fuller deploy pipeline so prompt changes are not left unapplied

## Recommended deployment sequence

After changing wrapper or cron behavior:

```bash
npm run sync:openclaw
npm run sync:dashboards
npm run sync:crons
```

Then verify with:

```bash
npm run smoke:cron -- --name "Daily overview with OpenClaw"
node /docker/openclaw-pma3/data/.openclaw/workspace-personal/lifestyle-ops.mjs scheduling-decisions --date today --days 2 --limit 2
```

## Related commits

- `ff079a4` `Improve task verification and Notion-first dashboard tooling`
- `0e9f82e` `Add memory-backed scheduling and cron sync tooling`
