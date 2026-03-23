# Notion-First UX Plan

## Scope

Improve the Lifestyle system for a user who works directly in Notion, not only through OpenClaw.

This document focuses on:

- single-message OpenClaw responses
- stale dashboard navigation
- a better daily execution surface
- a true daily calendar workflow
- clearer completion from inside Notion

## Current Findings

### 1. Dashboards are static navigation pages

The root, daily, and weekly pages are mostly static callouts with hardcoded links.

Observed live pages:

- Root page: `Lifestyle OS` `32a9c9a3-ced1-8163-a422-ff9ebfe69007`
- Daily page: `Daily Command Center` `32a9c9a3-ced1-815e-8640-cfd74e83514b`
- Weekly page: `Weekly Reset` `32a9c9a3-ced1-81c6-b8e8-f02a1ca30a50`

Observed behavior:

- these pages were last edited on 2026-03-21
- links are manually embedded in callout text blocks
- they are not regenerated from `LIFESTYLE_BOARD.json`
- month/year are already partially view-backed in the board registry, but the dashboard layer is still static prose + links

This means the navigation layer can drift even if the wrapper and board registry are correct.

### 2. The real execution UX is split across multiple views

Current daily experience is fragmented:

- `Today List`
- `Daily`
- `Calendar`
- `Needs Scheduling`

The user has to know which view answers which question:

- what do I need to do?
- what is scheduled when?
- what can I check off now?
- what still needs a time?

That is too much routing overhead for direct Notion usage.

### 3. The current `today` task set is not the same thing as “today on the calendar”

Live wrapper read on 2026-03-22 showed:

- `Create workout plan` is in `Horizon = today`
- but its `Scheduled Start` is `2026-03-23T18:30:00+02:00`

So a Notion user can easily see a task in the Today surface that is not actually scheduled today.

This is a modeling/UX mismatch:

- horizon answers commitment
- schedule answers placement

The UI needs to show both clearly and separately.

### 4. Completion inside Notion is available, but not optimized for daily use

The task database already has:

- `Status`
- `Stage`
- `Scheduled Start`
- `Scheduled End`
- `Needs Calendar`
- `Schedule Type`

That means direct-Notion completion is already possible, but the UX depends entirely on the view configuration.

Right now there is no evidence of a dedicated “today execution” view optimized for:

- quick check-off
- exact scheduled time visibility
- separation of scheduled vs unscheduled work

### 5. The current Calendar view is broad, not a true “today calendar”

The live `calendar` wrapper view is a general scheduled-task surface, not a dedicated same-day execution calendar.

For someone operating directly in Notion, the daily page should expose:

- a filtered today-only calendar
- a today-only checklist/list
- a needs-decision list for today/near-term unscheduled tasks

## Desired Notion-First UX

The direct Notion experience should answer three questions immediately:

1. What is on today?
2. What still needs to be done today?
3. What still needs a scheduling decision?

The best daily page is not a prose dashboard.
It is a thin navigation shell around a few highly opinionated database views.

## Recommended Changes

### A. Single-message OpenClaw behavior

Goal:

- OpenClaw should usually respond with one completed message instead of a chain of progress messages

Implementation:

- enforce in live instructions
- keep multi-message behavior only for genuinely long-running or blocked operations

Status:

- instruction added in live `PRODUCTIVITY.md`

### B. Replace static dashboard dependence with generated navigation

Goal:

- dashboard pages should be regenerated from the board registry instead of being hand-maintained callouts

Recommended implementation:

- add a `sync-dashboards` script
- source of truth should be `LIFESTYLE_BOARD.json`
- rewrite root/daily/weekly navigation blocks from registry-defined links
- always use view-backed month/year targets from the registry

Benefits:

- fixes stale menu drift
- keeps page links aligned with live view URLs
- reduces manual Notion maintenance

### C. Build one primary daily execution view

Recommended new or repurposed view:

- `Today Execution`

Purpose:

- this should be the default “work from Notion” surface

Suggested filters:

- not archived
- not done
- `Horizon = today`

Suggested visible properties:

- `Status`
- `Task Name`
- `Scheduled Start`
- `Scheduled End`
- `Priority`
- `Estimated Minutes`
- `Schedule Type`
- `Needs Calendar`

Suggested sort:

- `Scheduled Start` ascending
- then `Priority` descending
- then `Task Name`

Why:

- lets the user tick work off directly via `Status`
- exposes exact time inline
- keeps the operational surface in one place

### D. Add a real today-only calendar view

Recommended view:

- `Today Calendar`

Purpose:

- show only tasks actually scheduled today

Suggested filter:

- `Scheduled Start` is on or after today 00:00
- `Scheduled Start` is before tomorrow 00:00
- `Status != done`
- `Stage != archived`

If Notion’s built-in filter precision is too limited, use:

- date is today

Why:

- this solves the “what is exactly when?” problem
- this is better than asking the user to infer today’s timing from a broad calendar surface

### E. Separate scheduled today vs unscheduled today

Recommended additional view:

- `Today Needs Time`

Suggested filters:

- `Horizon = today`
- `Needs Calendar = true`
- no `Scheduled Start`
- `Status != done`

Why:

- prevents unscheduled calendar-worthy tasks from being lost inside the broader Today list
- makes “today but not yet placed” obvious

### F. Make direct completion easy inside Notion

For direct Notion usage, the cheapest path is:

- use `Status` as the visible completion control in daily views

Recommended view rule:

- keep `Status` as the first visible property in `Today Execution`

Optional follow-up:

- consider a Notion button or automation for one-time tasks if the native UX becomes too click-heavy

Constraint:

- wrapper semantics currently depend on `Status` and `Stage`, so any checkbox/button shortcut should still write those fields compatibly

### G. Add a human-readable time display property

Current raw fields:

- `Scheduled Start`
- `Scheduled End`

These are correct for automation but not ideal for fast scanning.

Recommended addition:

- a formula property like `Time Label`

Example output:

- `18:30-19:15`
- `Tue 18:30-19:15`
- `Unscheduled`

Why:

- cleaner in list views
- easier for direct Notion use than showing raw date-time columns

### H. Resolve the horizon vs schedule mismatch visually

Problem:

- a task can be in `today` while actually scheduled tomorrow

Recommended fixes:

- in `Today Execution`, show `Scheduled Start` prominently
- create a filtered view `Today Scheduled`
- optionally create a formula property `Schedule Day`

Rule of thumb:

- `today` means commitment
- `Scheduled Start` means placement

The UI should stop hiding that distinction.

### I. Make the daily page itself thinner

The daily dashboard should stop trying to be descriptive.

Recommended page structure:

- header
- `Today Execution`
- `Today Calendar`
- `Today Needs Time`
- small link strip to:
  - `Inbox`
  - `Blocked`
  - `This Week List`

The current prose/callout style is fine as a shell, but it should not be the main interface.

## What Can Be Automated vs Manual

### Can automate

- OpenClaw single-message behavior via workspace instructions
- dashboard block regeneration from registry
- board-registry-backed link synchronization
- wrapper-side checks that validate daily UX assumptions

### Likely manual or partially manual

- creating or reconfiguring Notion database views
- choosing final grouping/sorting aesthetics
- deciding whether completion should be `Status`, button, or both

Reason:

- Notion public API support for database-view configuration is limited compared with block/page edits

## Suggested Delivery Phases

### Phase 1

- enforce single-message behavior
- audit all root/daily/weekly dashboard links
- build a `sync-dashboards` script so static navigation stops drifting

### Phase 2

- define the canonical direct-use daily surfaces:
  - `Today Execution`
  - `Today Calendar`
  - `Today Needs Time`
- document exact filters, sorts, and visible properties

### Phase 3

- add one or two scan-friendly formula properties for direct Notion use:
  - `Time Label`
  - optional `Schedule Day`

### Phase 4

- add UX validation smoke checks:
  - no stale root/dashboard links
  - today page points to current live views
  - today execution surface clearly separates scheduled vs unscheduled

## Immediate Recommendation

The highest-value next step is:

1. keep the daily page as a shell
2. make one excellent `Today Execution` view
3. add one excellent `Today Calendar` view
4. generate dashboard links from the registry so they stop drifting

That gets the system closer to “usable directly in Notion” without fighting the limits of the public Notion API.
