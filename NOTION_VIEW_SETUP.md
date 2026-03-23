# Notion View Setup

This is the manual Notion UI pass that completes the direct-use workflow which the API cannot create.

The dashboard pages are now synced by code.
The remaining work is the database-view layer.

## Goal

Make Notion itself usable as the primary daily workspace without needing OpenClaw for basic execution.

## Daily Views

### 1. Today Execution

Purpose:

- the main list to work from
- fast scanning
- easy completion

Suggested source:

- `Lifestyle Tasks`

Suggested filter:

- `Horizon` is `today`
- `Status` is not `done`
- `Stage` is not `archived`

Suggested sort:

- `Scheduled Start` ascending
- `Priority` descending
- `Task Name` ascending

Suggested visible properties:

- `Status`
- `Task Name`
- `Scheduled Start`
- `Scheduled End`
- `Priority`
- `Estimated Minutes`
- `Schedule Type`
- `Needs Calendar`

Important:

- keep `Status` first so tasks are easy to mark done directly from the view

### 2. Today Calendar

Purpose:

- see exactly what is placed today

Suggested filter:

- `Scheduled Start` is `today`
- `Status` is not `done`
- `Stage` is not `archived`

Suggested layout:

- calendar

Suggested visible properties in card preview:

- `Task Name`
- `Schedule Type`
- `Priority`

### 3. Today Needs Time

Purpose:

- isolate today work that still needs scheduling

Suggested filter:

- `Horizon` is `today`
- `Needs Calendar` is checked
- `Scheduled Start` is empty
- `Status` is not `done`
- `Stage` is not `archived`

Suggested sort:

- `Priority` descending
- `Task Name` ascending

Suggested visible properties:

- `Task Name`
- `Priority`
- `Estimated Minutes`
- `Schedule Type`
- `Review Notes`

## Weekly Views

### 4. This Week Execution

Purpose:

- weekly commitment list that still works as an execution surface

Suggested filter:

- `Horizon` is `this week`
- `Status` is not `done`
- `Stage` is not `archived`

Suggested sort:

- `Scheduled Start` ascending
- `Priority` descending

Suggested visible properties:

- `Status`
- `Task Name`
- `Scheduled Start`
- `Priority`
- `Repeat Target Count`
- `Repeat Progress`

### 5. This Week Needs Time

Purpose:

- see all weekly tasks that still need placement

Suggested filter:

- `Horizon` is `this week`
- `Needs Calendar` is checked
- `Scheduled Start` is empty
- `Status` is not `done`
- `Stage` is not `archived`

## Optional Formula Properties

These still need manual creation because the Notion API cannot update formula properties here.

### 1. Time Label

Type:

- formula

Suggested formula:

```text
if(
  empty(prop("Scheduled Start")),
  "Unscheduled",
  formatDate(prop("Scheduled Start"), "HH:mm") +
  if(
    empty(prop("Scheduled End")),
    "",
    "-" + formatDate(prop("Scheduled End"), "HH:mm")
  )
)
```

### 2. Schedule Day

Type:

- formula

Suggested formula:

```text
if(
  empty(prop("Scheduled Start")),
  "",
  formatDate(prop("Scheduled Start"), "ddd")
)
```

These are useful for list views when the raw date columns feel too heavy.

## Page Wiring

Once the views exist:

- point the “Today Execution” dashboard language at the actual view you choose
- point “Today Needs Time” at the matching view
- if you create a dedicated “Today Calendar” view, replace the current generic `Calendar` link in the Daily page

## Completion Model

Recommended direct-use completion model:

- keep `Status` as the main completion control

Why:

- already compatible with wrapper logic
- avoids adding a second source of truth
- works well from table/list views

## Reality Check

The code now keeps root/daily/weekly dashboards synced and injects live snapshots.
What remains manual is mainly view design inside Notion.
