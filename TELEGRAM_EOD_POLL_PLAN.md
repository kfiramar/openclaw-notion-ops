# Telegram End-Of-Day Poll Plan

## Goal

Add an end-of-day Telegram-native poll flow for the Lifestyle system so that:

- OpenClaw sends a nightly poll covering the relevant `today` tasks
- selected options mean "done"
- unselected options mean "not done"
- the poll closes shortly after the first real interaction
- final selections are applied back into the Lifestyle wrapper safely
- the full flow is source-controlled, testable, and cron-driven

This document covers the entire implementation plan, including the current runtime limits, the required architecture changes, the data model, the cron wiring, and the smoke coverage needed to trust it in production.

## What Exists Today

### Confirmed working capabilities

- OpenClaw can send Telegram-native polls with `openclaw message poll`.
- The installed runtime supports Telegram poll send options such as:
  - question
  - options
  - anonymous/non-anonymous
  - single-select vs multi-select
  - timed close via Telegram `open_period`
- The Lifestyle wrapper already has the task state logic needed to compute end-of-day outcomes.
- The wrapper already knows how to:
  - show today work
  - close the day
  - archive completed one-time tasks
  - roll recurring tasks forward
  - carry unfinished work
  - exclude `@no-check` / auto-done tasks from confirmation flows

### Confirmed missing capabilities

- The current installed OpenClaw runtime does not expose Telegram read support through `openclaw message read`.
- The current installed runtime does not appear to expose Telegram `poll_answer` ingestion in a reusable automation path.
- The current installed runtime does not expose a simple CLI `stopPoll` path for Telegram poll closure.
- Therefore, the current system can send polls but cannot yet reliably consume poll answers and apply them back into Notion automatically.

## Why This Needs More Than "Just Add A Cron"

Sending a poll is only the outbound half of the workflow.

To make the poll useful for automation, the system must also:

- know exactly which task each poll option represents
- receive the final selected options
- know when the first interaction happened
- close the poll after the required delay
- map selected vs unselected options back to task page ids
- apply wrapper-safe mutations
- avoid double-applying results if the worker reruns

Without those pieces, the system can send a poll but cannot safely convert the answers into task state changes.

## Desired User Experience

### Primary UX

At the end of the day:

- OpenClaw sends one Telegram-native multi-select poll
- the poll lists the relevant `today` tasks
- the user selects every task that was actually done
- anything not selected is treated as not done
- after the first interaction, the poll remains open for 60 seconds
- after closure, OpenClaw applies results to the Lifestyle system automatically

### Intended semantics

- selected task:
  - treated as done
- unselected task:
  - treated as not done

### Important practical limit

Telegram polls have option limits.

The current OpenClaw send path documents `--poll-option` as repeatable `2-12` times, while the internal Telegram poll normalization path references a lower normalization cap in the installed runtime. This means the implementation must not assume "all today tasks in one poll forever" without enforcing a safe upper bound and fallback splitting logic.

The implementation must therefore support:

- one poll when the task count fits
- split polls when the count exceeds the safe limit

## Scope

This plan includes:

- wrapper commands for poll preparation and result application
- Telegram answer ingestion
- poll lifecycle persistence
- cron jobs
- close-after-first-interaction behavior
- smoke tests
- rollout sequence

This plan does not assume:

- changes to core Notion database schema
- replacement of the current evening summary
- immediate core OpenClaw upstream contribution

## Current Relevant Code And Runtime Surfaces

### Repo

- CLI entrypoint:
  - `notion-board-ops.mjs`
- core maintenance logic:
  - `src/maintenance.mjs`
- task shaping and summary helpers:
  - `src/tasks.mjs`
- cron source of truth:
  - `scripts/sync-openclaw-crons.mjs`
- sync/deploy helper:
  - `scripts/sync-to-openclaw.mjs`
- existing smoke patterns:
  - `scripts/smoke-*.mjs`
  - `scripts/e2e-live-smoke.mjs`

### Live OpenClaw runtime

- OpenClaw CLI supports:
  - `openclaw message poll`
- OpenClaw CLI does not currently support:
  - `openclaw message read` for Telegram in this install
- Installed runtime contains Telegram poll send support but no obvious reusable poll-answer application path

## Product Decisions To Lock Before Implementation

These decisions should be explicit in code and docs, not left implicit in prompts.

### 1. Candidate task inclusion

Recommended inclusion rules:

- include only tasks with `Horizon = today`
- exclude archived tasks
- exclude already-done tasks
- exclude synthetic/system tasks
- exclude routine summary tasks
- exclude tasks marked auto-complete / `@no-check`

Recommended implementation source:

- reuse the same filtering logic already used in human-facing evening flows where possible

### 2. Option ordering

Recommended order:

- scheduled tasks first by `Scheduled Start`
- then unscheduled tasks
- stable tie-break by title

Reason:

- makes the poll predictable
- matches the user's operational model of "what was actually on today"

### 3. Label format

Recommended label format:

- short, human-readable, compact label
- reuse current compaction rules where possible

Example:

- `workout plan`
- `startup breakdown`
- `pick up post`

Do not include page ids in poll text.

### 4. Selected vs unselected semantics

Recommended:

- selected = done
- unselected = not done

This is the user's requested model and should be hardcoded clearly.

### 5. No-response behavior

Recommended:

- no automatic mutation if the poll receives no answer before a defined timeout window
- optional short follow-up message next morning or leave for manual review

Reason:

- "no answer" is not the same thing as "all unchecked"

### 6. Poll close timing

Required behavior:

- when the first answer arrives, record timestamp
- close the poll 60 seconds later

If no answer arrives:

- keep it open only for a bounded maximum window or let Telegram timed close end it

### 7. Multi-poll behavior

If more than the safe option limit exists:

- split into deterministic batches
- each batch has its own poll state record
- application runs batch-by-batch but rolls up into one nightly run id

## Architecture Overview

The full flow should have five layers:

1. Candidate builder
2. Outbound poll sender
3. Poll state persistence
4. Inbound poll-answer ingestion
5. Result application

### Layer 1: Candidate builder

Purpose:

- compute the exact end-of-day confirmation set
- produce a stable machine-readable mapping from poll options to task page ids

### Layer 2: Outbound poll sender

Purpose:

- send one or more Telegram-native polls
- record returned `poll_id`, `message_id`, and chat id

### Layer 3: Poll state persistence

Purpose:

- store enough information to recover, resume, and apply later

### Layer 4: Inbound poll-answer ingestion

Purpose:

- receive user answers
- update selection state
- detect first interaction time

### Layer 5: Result application

Purpose:

- close polls
- apply selected/unselected outcomes to the wrapper safely
- record proof and idempotent outcome state

## Proposed New Wrapper Commands

These commands should be added to the repo wrapper rather than hidden in prompt-only behavior.

### 1. `list-eod-poll-candidates`

Purpose:

- read-only debug command
- shows what would appear in the nightly poll

Suggested output:

```json
{
  "ok": true,
  "action": "list-eod-poll-candidates",
  "date": "2026-03-23",
  "count": 4,
  "rows": [
    {
      "page_id": "...",
      "title": "...",
      "compact_label": "...",
      "scheduled_start": "...",
      "repeat_mode": "one_time"
    }
  ]
}
```

### 2. `build-eod-poll`

Purpose:

- build one or more poll payloads from candidate tasks

Suggested output:

```json
{
  "ok": true,
  "action": "build-eod-poll",
  "date": "2026-03-23",
  "run_id": "...",
  "polls": [
    {
      "batch_id": "...",
      "question": "What did you finish today?",
      "max_selections": 8,
      "options": [
        {
          "index": 0,
          "label": "workout plan",
          "page_id": "..."
        }
      ]
    }
  ]
}
```

### 3. `apply-eod-poll-results`

Purpose:

- apply final selected and unselected task outcomes

Suggested input model:

- `--date`
- `--selected-page-id <PAGE_ID>` repeatable
- `--unselected-page-id <PAGE_ID>` repeatable
- or JSON input mode if needed

Suggested output:

```json
{
  "ok": true,
  "action": "apply-eod-poll-results",
  "date": "2026-03-23",
  "selected_applied": [],
  "unselected_applied": [],
  "skipped": [],
  "errors": []
}
```

### 4. `verify-eod-poll-results`

Purpose:

- read back final state after apply
- ensure selected tasks became done/rolled/archived as expected
- ensure unselected tasks became carried/missed/preserved as expected

This can either be a dedicated command or a structured proof bundle inside `apply-eod-poll-results`.

## Proposed Poll State Store

The poll workflow needs durable state, not ephemeral process memory.

### Recommended location

Use a new state directory under the workspace history/state root, for example:

- `/data/.openclaw/workspace-personal/history/polls`

Host equivalent will be handled through the existing workspace mapping.

### Recommended file model

One JSON file per nightly run or per poll batch.

Recommended shape:

```json
{
  "version": 1,
  "run_id": "eod-2026-03-23-...",
  "batch_id": "batch-1",
  "date": "2026-03-23",
  "status": "sent",
  "created_at": "2026-03-23T19:30:00Z",
  "telegram": {
    "account": "bot4",
    "chat_id": "492482728",
    "message_id": "123",
    "poll_id": "abc"
  },
  "question": "What did you finish today?",
  "options": [
    {
      "index": 0,
      "label": "workout plan",
      "page_id": "..."
    }
  ],
  "first_interaction_at": null,
  "close_at": null,
  "selected_indexes": [],
  "selected_page_ids": [],
  "unselected_page_ids": [],
  "apply_result": null
}
```

### Required properties

- immutable mapping from option index to `page_id`
- first interaction timestamp
- current selection set
- poll closure status
- apply status
- final proof

## Telegram Inbound Requirements

This is the current critical gap.

### Needed capability

The system must ingest Telegram poll answer updates containing:

- poll id
- responding user
- selected option indexes
- timestamp

### Why poll id matters

We must map:

- Telegram `poll_id`
- back to stored batch state
- back to task `page_id`s

### Why selected option indexes matter

The system must convert:

- selected indexes -> selected page ids
- not selected indexes -> unselected page ids

### Implementation options

#### Option A: Extend OpenClaw runtime

Add proper Telegram poll-answer ingestion support inside the installed/runtime OpenClaw layer.

Pros:

- cleanest long-term solution
- native to the existing channel system
- consistent with other message actions

Cons:

- requires runtime patching or upstream OpenClaw source access

#### Option B: Add a sidecar Telegram helper

Create a small helper that talks directly to the Telegram Bot API for poll-answer updates.

Pros:

- can be built entirely from repo-side code
- avoids waiting on upstream runtime changes

Cons:

- creates a parallel integration path
- must be managed carefully to avoid drift from OpenClaw's bot config

### Recommendation

If the real OpenClaw source becomes available in workspace, prefer Option A.

If not, implement Option B in a narrow, well-contained way:

- only for poll answer updates
- only for the Lifestyle bot account
- only for this nightly poll workflow

## Poll Closing Requirements

### Required behavior

The user requested:

- "poll will close 1 minute after first interacting with it"

This means the system must support:

- detecting first answer timestamp
- scheduling closure at `first_answer + 60s`

### Required API operation

The system must be able to close an existing Telegram poll by:

- `chat_id`
- `message_id`

If OpenClaw runtime does not expose `stopPoll`, the sidecar/helper must.

### Watcher design

Recommended:

- a lightweight worker cron every minute
- scans active poll state files
- for each active poll:
  - if no interaction yet, skip
  - if `now >= close_at`, close the poll and mark closed
  - then apply results if not already applied

## Result Application Rules

This is where product semantics must be explicit.

### Selected tasks

Selected tasks should be treated exactly as if the user had confirmed "done".

Recommended behavior:

- one-time task:
  - log completion
  - clean calendar refs if needed
  - archive if current close-day rules archive it
- cadence recurring task:
  - log completion
  - roll due date forward
  - reset status/stage per existing recurring logic
- manual repeat:
  - mark done according to current manual-repeat close-day semantics

### Unselected tasks

Unselected tasks should be treated exactly as "not done".

Recommended behavior:

- if task was blocked:
  - preserve blocked state
- otherwise:
  - apply the same carry/miss logic used by the current end-of-day flow

Important:

- reuse existing wrapper behavior where possible
- do not fork a new parallel "done/not done" rules engine if `close-day` logic can be reused safely

### No-response tasks

If a poll receives no answer at all:

- do not auto-classify everything as "not done"
- record the poll as expired/unanswered
- leave task state unchanged or route to manual review

## Recommended Implementation Strategy

### Phase 1: Wrapper preparation layer

Add the read/build/apply commands first.

Files likely impacted:

- `notion-board-ops.mjs`
- `src/maintenance.mjs`
- `src/tasks.mjs`
- `README.md`

Deliverables:

- deterministic candidate builder
- deterministic poll payload builder
- structured result application command

### Phase 2: Poll state persistence

Add filesystem-backed JSON state for poll runs.

Files likely impacted:

- `src/util.mjs`
- new helper module, likely `src/polls.mjs`
- `src/maintenance.mjs`

Deliverables:

- create/read/update poll state files
- stable run ids and batch ids
- idempotent status transitions

### Phase 3: Outbound sender

Add a helper command or script that:

- calls `build-eod-poll`
- sends one or more Telegram polls
- stores message ids and poll ids

Possible file:

- new script such as `scripts/send-eod-poll.mjs`

### Phase 4: Inbound answer ingestion

Implement the missing answer path.

Possible paths:

- OpenClaw runtime patch
- sidecar Telegram API helper

Deliverables:

- store selected indexes on answer events
- store first interaction time if absent
- compute `close_at`

### Phase 5: Close watcher

Add a minute-based worker that:

- scans active poll state
- closes eligible polls
- computes selected/unselected page ids
- applies results

Possible file:

- `scripts/process-eod-polls.mjs`

### Phase 6: Cron integration

Update cron source of truth in:

- `scripts/sync-openclaw-crons.mjs`

Recommended cron additions:

- `Lifestyle daily completion poll`
- `Lifestyle daily completion poll watcher`

### Phase 7: Verification and smoke coverage

Add real manual smoke scripts and live-safe tests.

## Cron Design

### Option 1: Replace the current evening summary

Not recommended initially.

Reason:

- the current evening summary is already useful
- replacing it would remove a proven human-readable fallback during rollout

### Option 2: Keep the evening summary and add the poll after it

Recommended.

Flow:

1. existing `Daily overview with OpenClaw` runs
2. new `Lifestyle daily completion poll` runs shortly after
3. watcher cron closes/apply results later

Benefits:

- preserves current summary UX
- gives a textual fallback while the poll workflow matures

### Suggested schedule shape

Example only:

- `21:30` evening summary
- `21:35` send completion poll
- `* * * * *` watcher cron

## File-Level Work Plan

### Repo files likely to change

- `notion-board-ops.mjs`
  - register new commands
- `src/maintenance.mjs`
  - candidate builder
  - poll builder
  - result application
- `src/tasks.mjs`
  - any additional summary/filter helpers
- `src/util.mjs`
  - state file helpers if needed
- `scripts/sync-openclaw-crons.mjs`
  - new cron definitions
- `README.md`
  - command docs
  - cron docs
- new helper modules/scripts:
  - `src/polls.mjs`
  - `scripts/send-eod-poll.mjs`
  - `scripts/process-eod-polls.mjs`
  - optional Telegram sidecar helper if OpenClaw runtime is not extended

### Live/runtime files that may need changes

If poll-answer handling is implemented inside installed OpenClaw runtime:

- installed OpenClaw Telegram runtime code under `/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/...`

This is not ideal as the final state, but it may be needed until the real OpenClaw source is available locally.

## Data Contracts

### Candidate row contract

Recommended fields:

- `page_id`
- `title`
- `compact_label`
- `scheduled_start`
- `scheduled_end`
- `repeat_mode`
- `needs_calendar`
- `auto_complete_when_scheduled`

### Built poll contract

Recommended fields:

- `run_id`
- `batch_id`
- `question`
- `options`
- `safe_option_count`
- `is_split`

### Stored poll state contract

Recommended fields:

- `run_id`
- `batch_id`
- `status`
- `telegram.poll_id`
- `telegram.message_id`
- `options[index].page_id`
- `first_interaction_at`
- `close_at`
- `selected_indexes`
- `selected_page_ids`
- `unselected_page_ids`
- `apply_result`

### Apply result contract

Recommended fields:

- `selected_applied`
- `unselected_applied`
- `skipped`
- `errors`
- `verified`

## Edge Cases To Design For

### 1. More tasks than Telegram option limit

Must split into multiple polls deterministically.

### 2. Duplicate compact labels

Two tasks may compact to the same human label.

Solution:

- label text may need short disambiguation suffixes
- option index to page id mapping remains the real source of truth

### 3. Task deleted after poll sent

If a task is archived/deleted manually before apply:

- skip safely
- record as skipped

### 4. Task already completed before apply

If a task was completed by another path after poll send:

- treat as idempotent success
- do not double-log completion

### 5. No answers received

- mark run `expired_unanswered`
- do not auto-apply not-done semantics

### 6. User changes selection before close

The final applied result should use the latest known selection state at close time.

### 7. Multiple answers from multiple users

If this remains a 1:1 direct chat, this is simpler.

If group chat is ever used:

- must explicitly constrain allowed actor or define merge semantics

### 8. Poll split across multiple batches

- each batch closes and applies independently
- nightly run summary should aggregate them

### 9. Tasks marked `@no-check`

- must be excluded from poll candidates entirely

### 10. Synthetic/system tasks

- must be excluded entirely

## Smoke Test Plan

These should be real manual smoke scripts, not automatic scheduled jobs.

### Required smoke scripts

- `scripts/smoke-eod-poll-build.mjs`
- `scripts/smoke-eod-poll-send.mjs`
- `scripts/smoke-eod-poll-apply.mjs`
- `scripts/smoke-eod-poll-watcher.mjs`
- `scripts/smoke-eod-poll-split.mjs`

### Required smoke scenarios

#### 1. Candidate selection smoke

Verify:

- only expected today tasks are included
- auto-done tasks are excluded
- archived/done tasks are excluded

#### 2. Poll build smoke

Verify:

- option labels are stable
- option index to page id mapping is correct
- split behavior triggers correctly when over limit

#### 3. Poll send smoke

Verify:

- Telegram poll sends successfully
- returned `poll_id` and `message_id` are stored

#### 4. First interaction smoke

Verify:

- first answer sets `first_interaction_at`
- `close_at` becomes `+60s`

#### 5. Close watcher smoke

Verify:

- watcher closes the poll when due
- closed polls are not re-closed repeatedly

#### 6. Apply selected results smoke

Verify:

- selected one-time tasks archive correctly
- selected recurring tasks roll forward correctly

#### 7. Apply unselected results smoke

Verify:

- miss count increments where expected
- carry/reset logic matches current wrapper semantics

#### 8. No-response smoke

Verify:

- no automatic task mutation occurs
- state records unanswered outcome

#### 9. Duplicate labels smoke

Verify:

- collisions do not break mapping to page ids

#### 10. Idempotency smoke

Verify:

- rerunning watcher/apply does not double-complete or double-carry tasks

## Rollout Plan

### Stage 1: Planning and schema

- finalize candidate rules
- finalize state schema
- finalize split limit

### Stage 2: Wrapper-only repo work

- add `list-eod-poll-candidates`
- add `build-eod-poll`
- add `apply-eod-poll-results`
- add smoke coverage for wrapper-only logic

### Stage 3: Outbound poll cron

- add send script
- add cron definition
- verify outbound poll creation manually

### Stage 4: Inbound answer support

- implement poll answer ingestion
- verify selected indexes are stored correctly

### Stage 5: Watcher and close logic

- implement close-after-first-interaction
- implement apply-on-close
- add watcher cron

### Stage 6: Live trial

- test with a deliberately small today task set
- verify end-to-end result application

### Stage 7: Normal operation

- keep evening summary
- keep poll cron
- keep watcher cron
- maintain manual smoke scripts for debugging

## Risks

### 1. Runtime gap risk

The biggest blocker is the current lack of Telegram poll-answer ingestion in the installed automation path.

### 2. Option count risk

The poll option limit means the implementation must support split batches from the start.

### 3. Idempotency risk

If result application is not idempotent, reruns could double-log completions or double-increment misses.

### 4. Drift risk

If a sidecar helper is used for Telegram answers, it must stay aligned with OpenClaw account configuration.

### 5. Ambiguity risk

If inclusion rules are not explicit, users will distrust the poll because it will ask about the wrong tasks.

## Recommended First Implementation Slice

The best first slice is:

1. build deterministic candidates
2. build deterministic poll payloads
3. send poll and persist state
4. do not yet auto-apply answers

Reason:

- this gives immediate user-visible value
- proves the outbound UX
- avoids pretending answer automation is solved before it is

Then the second slice is:

5. implement answer ingestion
6. implement close watcher
7. implement result application

## Success Criteria

The feature should be considered complete only when all of these are true:

- nightly poll includes the correct confirmable today tasks
- selected options are mapped back to exact task page ids
- first interaction reliably starts the 60-second close timer
- the poll is closed automatically
- selected tasks are marked done through wrapper-safe logic
- unselected tasks are handled through wrapper-safe not-done logic
- reruns are idempotent
- smoke scripts exist for the major scenarios
- cron definitions are source-controlled
- documentation explains both the happy path and the runtime limits

## Recommendation

Proceed, but do it as a tracked workflow with explicit state and tests.

Do not implement this as:

- a pure prompt hack
- a send-only cron
- a best-effort message flow with no stored mapping

The correct shape is:

- wrapper commands
- poll state
- Telegram answer ingestion
- close watcher
- result apply
- smoke coverage

That is the minimum honest design for "one nightly poll where checked means done and unchecked means not done."
