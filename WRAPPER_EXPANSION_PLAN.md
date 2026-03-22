# Wrapper Expansion Plan

## Goal

Expand the Lifestyle/OpenClaw Notion wrapper so it is:

- deterministic for automation
- safe for destructive operations
- verifiable immediately after writes
- resilient across host-mode and in-container execution
- backed by real end-to-end smoke coverage

This plan is based on the current repo code, the deployed live wrapper behavior, and recent real failures observed in production-style usage.

## Current System Shape

### Entrypoints

- Repo CLI entrypoint: `notion-board-ops.mjs`
- Live synced wrapper entrypoint: `/data/.openclaw/workspace-personal/lifestyle-ops.mjs`
- Live sync script: `scripts/sync-to-openclaw.mjs`
- Main smoke script: `scripts/e2e-live-smoke.mjs`

### Core modules

- `src/commands.mjs`
  - task mutations and direct read commands
- `src/tasks.mjs`
  - task lookup, matching, board/mirror reads, horizon/stage inference
- `src/notion.mjs`
  - Notion API execution, mirror sync, runtime path resolution
- `src/calendar.mjs`
  - Google Calendar reads/writes
- `src/history.mjs`
  - append-only completion logging
- `src/maintenance.mjs`
  - planning/review/sweep logic
- `src/util.mjs`
  - argument parsing, JSONL helpers, normalization, filesystem helpers

### Live architecture constraints

- Repo code is the source of truth.
- Live OpenClaw workspace is generated from repo code via `scripts/sync-to-openclaw.mjs`.
- Wrapper must run in two environments:
  - host mode, where `docker exec ...` is available
  - in-container agent mode, where `docker` may be unavailable and direct `node` / `gog` invocation must work
- Mirror-first reads are fast, but immediate read-after-write can race the mirror.

### Current strengths

- Core task lifecycle exists: add/capture/promote/defer/block/complete/archive/set schedule/remove schedule/reschedule.
- Calendar lifecycle exists: set/link/unlink/verify/remove.
- Planning layer exists: `plan-day`, `plan-week`, `schedule-sweep`, `scheduling-decisions`, `review-stale`, `reconcile-calendar`.
- Live smoke already covers a meaningful portion of the wrapper.

### Current validated gaps

These are not theoretical. They were exposed in actual use:

- read-after-write could fail by title match immediately after a successful write
- wrapper previously failed in-container with `spawnSync docker ENOENT`
- destructive intent mapping was ambiguous:
  - "remove from calendar" should only unschedule
  - "delete task" should delete the task for one-time work
- recurring vs one-time deletion needed an explicit safety boundary
- verification existed for schedule linkage only, not for general task state
- completion history path handling is still brittle if the target path is not writable
- output is JSON today, but not standardized as a strict result envelope across all commands

## Recent Real Fixes Already Landed

These matter because the new work should build on them, not re-solve them differently.

- host/in-container runtime fallback was added to:
  - `src/calendar.mjs`
  - `src/notion.mjs`
- lookup now has a live-read fallback in `src/tasks.mjs` so immediate title lookup can survive mirror lag
- `delete-task` was added for non-recurring one-time tasks
- live workspace instructions were updated so OpenClaw:
  - asks fewer unnecessary questions
  - treats explicit one-time-task deletion as approved
  - keeps calendar cleanup separate from task deletion

## Requested Feature Set

### High value additions

1. `find-task` / `search-tasks`
2. structured output mode consistency
3. `delete-task --verify`
4. `remove-schedule --verify`
5. `capture --verify` / `set-schedule --verify`
6. deterministic exact title lookup:
   - `--title-exact`
   - `--first`
   - `--latest`

### Fixes / runtime gaps

7. reliable immediate read-after-write without external sync
8. graceful sync behavior when `docker` is unavailable
9. permission-safe completion history path
10. general `verify-task`

### Nice-to-have

11. bulk safe cleanup with preview/apply
12. `clone-task`
13. `rename-task`
14. `list-recent-writes`
15. stable operation ids / proof bundle ids

## Important Context By Area

### Lookup and task identity

Current lookup is centered in `src/tasks.mjs`.

Current behavior:

- `--page-id` is strongest and should remain the preferred path
- title matching supports:
  - exact normalized title
  - wildcard match via `*` / `?`
  - substring fallback
- title matching can still be ambiguous without deterministic selectors

Needed changes:

- add a reusable selector layer that accepts:
  - `--page-id`
  - `--match`
  - `--title-exact`
  - `--first`
  - `--latest`
- add read commands that return:
  - `page_id`
  - `title`
  - `archived`
  - schedule state
  - calendar event id
  - maybe last edited time for deterministic "latest"

Impacted files:

- `src/tasks.mjs`
- `src/commands.mjs`
- `notion-board-ops.mjs`
- `README.md`
- smoke tests

### Structured output

Current state:

- wrapper commands already print JSON
- but the result shape is not fully standardized
- different commands expose different field names and different proof depth

Needed changes:

- standardize a mutation result envelope:
  - `ok`
  - `action`
  - `operation_id`
  - `page_id`
  - `task`
  - `verified`
  - `proof`
- standardize read/search envelope:
  - `ok`
  - `action`
  - `count`
  - `rows`

Decision:

- because commands already emit JSON, this is probably not a new `--json` implementation problem
- it is mainly a response schema consistency problem

Impacted files:

- `src/commands.mjs`
- `src/maintenance.mjs`
- `README.md`
- smoke tests

### Verification layer

Current state:

- `verify-schedule` checks task schedule fields against the linked calendar event
- there is no general task verification command

Needed changes:

- implement `verify-task` as a shared proof surface
- support verification dimensions such as:
  - `exists`
  - `archived`
  - `scheduled`
  - `unscheduled`
  - `linked`
  - `unlinked`
  - `stage`
  - `status`
  - `horizon`
  - `calendar_event_status`

Then reuse it for:

- `delete-task --verify`
- `remove-schedule --verify`
- `capture --verify`
- `set-schedule --verify`
- maybe `rename-task --verify`

Impacted files:

- `src/commands.mjs`
- `src/tasks.mjs`
- `src/calendar.mjs`
- smoke tests

### Read-after-write correctness

Current state:

- writes go through Notion immediately
- mirror refresh is kicked in the background
- title-based reads may race the mirror
- `--page-id` works better because it can use live `getPage`

Needed changes:

- keep the existing live fallback
- formalize it so any command that receives a page id from a prior mutation can use it immediately
- consider returning richer proof directly from the mutation result to reduce the need for immediate rereads
- verification flags should default to page-id-based rereads, not match-based rereads

Impacted files:

- `src/tasks.mjs`
- `src/commands.mjs`
- smoke tests

### No-docker runtime

Current state:

- runtime fallback was added for calendar and notion command execution
- this solved actual `docker ENOENT` failures for core flows
- `sync` and mirror-related paths still need deeper validation in both environments

Needed changes:

- explicitly document supported runtime modes
- audit `sync`, full sync, and background sync helpers for environment-sensitive assumptions
- add smoke coverage for:
  - host mode
  - in-container mode
  - missing docker binary

Impacted files:

- `src/notion.mjs`
- `src/calendar.mjs`
- `scripts/sync-to-openclaw.mjs`
- smoke tests

### Completion history permissions

Current state:

- `src/history.mjs` writes JSONL directly through `appendJsonLine`
- `appendJsonLine` just ensures the directory and writes
- there is no recovery strategy if the path exists but is not writable

Needed changes:

- add a safe write strategy:
  - create path if missing
  - if permission denied, use a known writable fallback
  - or fail with a structured, explicit recovery error
- decide whether history write failure should:
  - fail the parent command
  - or degrade with `warning` and continue

Recommended default:

- for destructive lifecycle operations, prefer a structured warning plus fallback if possible
- do not silently lose the history write

Impacted files:

- `src/history.mjs`
- `src/util.mjs`
- `src/commands.mjs`
- smoke tests with a forced unwritable path

### Deletion semantics

Current state:

- `remove-schedule` is correct for calendar cleanup only
- `delete-task` now exists for non-recurring one-time tasks
- recurring tasks are guarded

Needed follow-up:

- `delete-task --verify`
- maybe `delete-task --preview`
- explicit docs in repo, not just live workspace docs
- ensure agent language maps correctly:
  - "off my calendar" -> `remove-schedule`
  - "delete the task" -> `delete-task`

Impacted files:

- `src/commands.mjs`
- `README.md`
- maybe repo-level docs for agent guidance if later imported into another workspace

### Bulk cleanup

Needed behavior:

- search temp tasks safely
- show matched rows first
- then apply archive/delete/remove-schedule
- return machine-readable result with:
  - matched
  - skipped
  - applied
  - failed

Recommended command shape:

- `search-tasks --match "*E2E*"`
- `delete-task --match "*E2E*" --all-matches --preview`
- `delete-task --match "*E2E*" --all-matches --apply`

Impacted files:

- `src/tasks.mjs`
- `src/commands.mjs`
- smoke tests

### Rename / clone / recent writes / operation ids

These are lower priority, but easy to misdesign if added ad hoc.

Recommended design:

- `rename-task`
  - update title only
  - optionally update linked calendar summary if currently linked
- `clone-task`
  - copy selected properties, not raw entire page payload
  - no automatic linked event reuse
- `list-recent-writes`
  - read from a local mutation log
  - return operation id, action, page id, timestamp
- operation ids
  - generate once per mutation command
  - include in stdout and mutation log

Impacted files:

- `src/commands.mjs`
- possibly new mutation log helper near `src/history.mjs`
- smoke tests

## Recommended Delivery Order

### Phase 1: deterministic lookup and shared result envelopes

- `find-task`
- `search-tasks`
- exact selector support
- consistent result schema

Why first:

- every later verify/cleanup feature depends on deterministic lookup

### Phase 2: verification framework

- `verify-task`
- `delete-task --verify`
- `remove-schedule --verify`
- `capture --verify`
- `set-schedule --verify`

Why second:

- this collapses many manual proof flows into single operations

### Phase 3: runtime hardening

- no-docker sync checks
- permission-safe completion history writes
- explicit degradation behavior

Why third:

- this reduces production surprises during normal use and cron execution

### Phase 4: bulk ergonomics

- preview/apply bulk cleanup
- `rename-task`
- `clone-task`

### Phase 5: traceability

- `list-recent-writes`
- stable operation ids

## Deep Smoke Test Plan

The existing `scripts/e2e-live-smoke.mjs` is the right place to extend. It already:

- creates real Notion tasks
- creates and removes real Google Calendar events
- verifies real schedule linkage
- performs cleanup at the end

It should be expanded into grouped suites.

### Suite A: lookup and identity

- add task
- find by `page-id`
- find by exact title
- find by wildcard
- find by substring
- test `--latest`
- test `--first`
- test ambiguity behavior

### Suite B: read-after-write

- capture task
- immediately read by returned page id
- immediately read by exact title
- verify without calling `sync`

### Suite C: schedule verification

- capture scheduled task with `--verify`
- set schedule with `--verify`
- remove schedule with `--verify`
- relink existing calendar event and verify

### Suite D: deletion lifecycle

- delete one-time task and verify:
  - page archived
  - calendar event cancelled
- attempt delete on recurring task and assert safe refusal

### Suite E: completion history resilience

- force a non-writable history root
- run completion/archive path
- assert structured fallback/warning behavior

### Suite F: runtime mode coverage

- host wrapper invocation
- in-container wrapper invocation
- explicit no-docker environment where direct execution is required

### Suite G: bulk cleanup

- create multiple temp tasks
- preview matches
- apply removal/delete
- verify no matched live tasks remain
- verify linked events are cancelled

### Suite H: mutation traceability

- run several writes
- assert operation ids exist
- assert `list-recent-writes` returns them in order

## Per-Feature Test Matrix

This section is the explicit implementation checklist for test coverage. A feature is not done until its matching smoke cases exist.

### 1. `find-task` / `search-tasks`

- create 3 temporary tasks with distinct titles
- find exact by `--page-id`
- find exact by `--title-exact`
- find by wildcard `*tmp*`
- find by substring `tmp`
- create two tasks with same title stem and different `last_edited_time`
- assert `--latest` chooses the newer row
- assert `--first` chooses the older row
- assert ambiguous lookup without selector fails clearly
- assert search output includes:
  - `page_id`
  - `title`
  - `archived`
  - `stage`
  - `status`
  - `horizon`
  - `schedule_state`
  - `calendar_event_id`
  - `scheduled_start`
  - `scheduled_end`
  - `last_edited_time`

### 2. Structured output consistency

- run representative commands from each category:
  - read: `show`, `find-task`, `search-tasks`
  - write: `capture`, `promote`, `remove-schedule`, `delete-task`
  - verify: `verify-schedule`, later `verify-task`
  - maintenance: `plan-day`, `schedule-sweep`
- assert each result includes the expected top-level envelope keys for its category
- assert failures return machine-readable stderr or explicit structured error text that does not require prose scraping

### 3. `delete-task --verify`

- create one-time unscheduled task
- delete with `--verify`
- assert:
  - final page archived/in trash
  - no active mirror match remains after sync
  - proof bundle reports archived true
- create one-time scheduled task
- delete with `--verify`
- assert linked event is cancelled
- create recurring task
- assert `delete-task --verify` refuses without override

### 4. `remove-schedule --verify`

- create scheduled task
- remove schedule with `--verify`
- assert:
  - `Scheduled Start` cleared
  - `Scheduled End` cleared
  - `Calendar Event ID` cleared
  - event is cancelled
  - stage/status are updated consistently

### 5. `capture --verify` / `set-schedule --verify`

- capture unscheduled one-time task with `--verify`
- assert created task exists with correct fields
- capture scheduled task with `--verify`
- assert calendar event exists and task is synced
- set schedule on existing task with `--verify`
- assert event exists and task verification succeeds immediately

### 6. Deterministic exact title lookup

- create two tasks with same exact title
- assert plain exact lookup is ambiguous
- assert `--first` and `--latest` resolve deterministically
- assert `--title-exact` does not fall through to substring logic

### 7. Immediate read-after-write

- capture task
- immediately `find-task --page-id`
- immediately `find-task --title-exact`
- immediately `verify-schedule` if scheduled
- no manual `sync` allowed in this test path

### 8. No-docker runtime / sync degradation

- run core read/write/verify flows from host mode
- run same flows inside container
- run with `DOCKER_BIN` missing/unset in-container
- assert wrapper falls back to direct command execution
- run `sync`
- assert graceful behavior in no-docker mode

### 9. Completion history permission safety

- point `HISTORY_ROOT` or completion target to an unwritable path
- run `complete-task` / archive path
- assert:
  - either fallback path is used successfully
  - or a clear structured warning/error is returned
- verify no silent success with lost history record

### 10. `verify-task`

- verify active unscheduled task
- verify active scheduled task
- verify archived task
- verify task with missing calendar link
- verify task with cancelled event
- assert command returns all relevant proof fields

### 11. Bulk safe cleanup

- create several temp tasks matched by a wildcard
- preview matched set
- apply cleanup
- assert:
  - matched rows are returned before apply
  - all targeted rows are archived/unscheduled as requested
  - unrelated rows remain untouched

### 12. `clone-task`

- clone one-time unscheduled task
- assert copied properties and new page id
- clone scheduled task
- assert cloned task does not reuse old calendar event id unless explicitly intended

### 13. `rename-task`

- rename unscheduled task
- assert title changed
- rename scheduled task
- assert linked calendar event summary behavior matches intended policy

### 14. `list-recent-writes`

- perform multiple mutations in sequence
- assert recent writes list:
  - returns operation ids
  - is ordered newest first
  - includes action and page id

### 15. Stable operation ids

- every mutation command returns an operation id
- same command invocation has one id across stdout/proof/log surfaces
- ids can be correlated in `list-recent-writes`

## Acceptance Criteria

### Functional

- no destructive one-time-task deletion should require a second confirmation when the user explicitly asked for deletion and the target is unambiguous
- recurring tasks must still be protected
- no mutation should require a manual `sync` to prove its own success
- all verification commands must work in host mode and in-container mode

### Output

- all mutations return a consistent machine-readable envelope
- all verification commands return explicit proof fields
- search/find commands return rows suitable for automation without scraping human text

### Runtime

- in-container operation must not require `docker`
- history write failures must degrade clearly and predictably

### Testing

- smoke suite must cover each new command and each new failure mode
- smoke suite must clean up its own Notion pages and calendar events

## Recommended Concrete Work Breakdown

### Workstream 1: lookup + schema

Files:

- `src/tasks.mjs`
- `src/commands.mjs`
- `notion-board-ops.mjs`
- `README.md`

Deliverables:

- `find-task`
- `search-tasks`
- exact selectors
- standardized JSON envelopes

### Workstream 2: verification

Files:

- `src/commands.mjs`
- `src/tasks.mjs`
- `src/calendar.mjs`

Deliverables:

- `verify-task`
- `delete-task --verify`
- `remove-schedule --verify`
- `capture --verify`
- `set-schedule --verify`

### Workstream 3: runtime hardening

Files:

- `src/notion.mjs`
- `src/calendar.mjs`
- `src/history.mjs`
- `src/util.mjs`

Deliverables:

- no-docker sync compatibility
- completion-history fallback/clear structured failure

### Workstream 4: ergonomics + observability

Files:

- `src/commands.mjs`
- maybe a new helper module for mutation log state

Deliverables:

- bulk preview/apply
- rename
- clone
- recent writes
- operation ids

### Workstream 5: live smoke

Files:

- `scripts/e2e-live-smoke.mjs`
- `README.md`

Deliverables:

- expanded end-to-end coverage for all above

## Risks

- adding too many flags to existing commands can make the surface hard to reason about
- mirror/live-read fallback logic can become inconsistent if implemented in several places instead of one selector layer
- verification commands can accidentally prove mirror state instead of real state if they do not force the correct live reads
- bulk cleanup is dangerous unless preview/apply separation is strict
- rename semantics are subtle when a linked calendar event exists and the summary must stay aligned

## Recommended Design Principles

- page id beats title
- live reads beat mirror reads immediately after writes
- verification should operate on facts, not assumptions
- destructive commands should be strict by default and easy to prove
- one shared selector layer, one shared verification layer, one shared result envelope

## Immediate Next Step

Implement Phase 1 first:

- add deterministic lookup primitives
- add `find-task` / `search-tasks`
- standardize command result envelopes
- extend smoke coverage for lookup and read-after-write

That will make every later feature substantially easier and safer to implement.
