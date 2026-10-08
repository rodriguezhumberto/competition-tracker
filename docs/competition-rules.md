# Competition rules

## Competitions and metrics

One competition and one Power Hour can be active at a time. Competition dates bound accepted reports; Power Hours run independently.

Create a competition with manual metrics, a reviewed suggestion from a sample image, or an existing template. Sample discovery never imports scores. Each competition supports 1–20 metrics with type, precision, bounds, required status, visibility, display order, and ranking direction. Participant identifiers are text, preserving leading zeroes.

| Scoring mode        | Behavior                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| Daily running total | Counts differences within a day; resets the baseline to zero each new day. |
| Additive            | Adds each submitted amount.                                                |
| Latest value        | Uses the latest observation within the selected period.                    |

Missing optional values remain missing and do not reset a daily baseline. Negative values are allowed unless a minimum excludes them. Values support 0–6 decimal places within ±1,000,000,000; storage and aggregation use scaled integers.

## Tracked items

Enable **Track multiple items** to track several products or other report categories in one competition. Each item has a name and a unique report code, stored as text to preserve leading zeroes. The item label can be customized. With this option off, reports and standings follow the single-stream flow.

Each report belongs to one configured item. Review the detected header code before confirming; missing, unreadable, unfamiliar, or ambiguous codes require an explicit selection. Admins can add an item during review without importing scores. A report containing a combined range of items must not be submitted alongside individual-item reports covering the same activity.

Daily baselines and timestamp checks run separately for each participant and item. Reports for different items can share a timestamp; duplicate or older reports for the same participant and item are rejected. Additive amounts sum across items. Latest-value metrics use the latest observation for each item within the selected period, then sum those observations. Use compatible quantities when combining items; rates and percentages should not be treated as additive totals.

The leaderboard defaults to **All items**, the official combined standings. Selecting an item recalculates that item's scores and ranks. Metric, period, activity, and CSV views preserve the selection. Item reporting status shows the latest accepted report in the selected period; items with no report remain unreported rather than implying a confirmed zero.

Tracking mode locks after reports are accepted, and item codes used by reports cannot be removed. Item names remain editable and new items can be added. Configuration changes invalidate stale drafts; adding an item from a draft keeps that draft current and requires other drafts to be reviewed again.

One public metric determines official ranking. Viewers can sort by other visible metrics; equal scores share rank and missing scores are unranked. Private metrics appear only in admin views.

Changing the official ranking or adding a metric requires acknowledgement. Earlier reports remain missing for new metrics. Existing metrics cannot be deleted; type, precision, currency, and scoring mode lock once values exist. Labels, visibility, required status, future bounds, aliases, and order remain editable. Version checks reject stale edits.

## Report dates

Reports include a generation timestamp and covered start/end dates. Zone-less clocks use the competition timezone (default `America/Chicago`); explicit printed offsets take precedence. Stored timestamps are UTC. Daily and Monday–Sunday views follow the competition timezone.

- Covered dates must fall within competition dates and cannot end after generation.
- Competitions with daily metrics require single-day reports. Multi-day additive/latest reports count on their end date.
- Spring DST gaps are invalid; repeated fall clocks require an explicit offset.
- Duplicate or older participant timestamps and future generation times reject the entire batch.

Recent activity and CSV timestamps display Central time with CST/CDT labels. The main board shows up to 12 recent rows; **View report activity** opens the audience-filtered history with 20 rows per page. Standings include all reports in the selected period.

## Power Hours

Admins set a name, duration (1–1440 minutes; default 60), and shared password (8–128 characters). They can extend a live session or end it early. Results archive at the scheduled end or manual end and remain separate from competition reports.

Up to 20 participants join with the password and a unique name of at most 20 characters. Names are checked for unsafe characters and offensive terms. A browser credential reserves the name and restores participation after refresh or reconnect; scores are sent only to authenticated sockets. A lost cookie currently has no name-recovery flow.

More than 10 accepted taps per participant in a rolling 60 seconds flags the score for review; more than 15 taps in a second are rejected. Flags remain in archives. Credentials stop working when the session ends, and stale taps cannot enter a new session. The escape hatch hides the live view without disconnecting.

Legacy sessions without an end time retain the 60-minute limit. Active sessions created before browser credentials were introduced must be ended and restarted for secure joining.
