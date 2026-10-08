# Implemented review changes

Review items 10 and 11 were approved and implemented. This document records the resulting behavior.

## 10. Consolidate time utilities

`src/lib/time.ts` now owns strict ISO parsing, timezone validation, wall-clock-to-UTC conversion, and local display formatting. Both the configurable report flow and Chicago-only entry flow call this implementation, removing duplicated DST handling and the circular dependency through validation.

- Chicago wrappers pass `America/Chicago` and preserve the CST/CDT selector's offset validation.
- `calendar.ts` handles date-only validation and `calendarWeek`; `centralWeek` remains a compatibility alias.
- Formatters are reused in a bounded cache by timezone.
- DST gaps and repeated clocks without an explicit offset remain invalid. Printed offsets remain authoritative.
- Regression tests cover Chicago winter/summer, milliseconds, midnight rollover, fall overlap, spring gap, invalid dates and offsets, and a fractional-offset timezone.

No stored timestamps, historical report days, baselines, or competition timezone settings are rewritten. The separately authorized CSV fix already displays Chicago time with CST/CDT labels while preserving UTC storage.

## 11. Draft lifecycle

| Stage                | Behavior                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extracting           | Extraction happens before artifact writes. Failed writes remove partial files; failed deletions are queued for retry. No draft or standings change yet.                                            |
| Reviewable           | Successful extraction stores a random token, original extracted payload, editable payload, proof references, schema/profile versions, creation time, and fixed 24-hour expiry.                     |
| Reviewing            | An authenticated admin can reopen the draft from a pending-drafts list. An explicit Save draft action persists edits using a draft revision to reject stale saves. Editing does not extend expiry. |
| Confirming           | One IMMEDIATE transaction verifies the token, expiry, draft revision, competition schema/profile versions, report validity, and current baselines, then writes the report and consumes the draft.  |
| Confirmed            | Permanent reports retain their original/processed proofs and processing metadata. The consumed draft cannot be reused, and its images are excluded from draft cleanup.                             |
| Discarded or expired | The draft immediately stops accepting saves or confirmation. A retained cleanup record lists its artifacts until deletion succeeds.                                                                |
| Cleaned              | Delete the cleanup record after all artifacts are gone. Missing files count as successful cleanup; other failures are logged and retried.                                                          |

Cleanup runs at server startup and every minute, independent of uploads and provider availability. All draft mutations require admin authentication and same-origin requests. Claiming a draft for confirmation or cleanup is mutually exclusive in the database, so a cleaner cannot delete proofs while confirmation is committing. Filesystem cleanup occurs after that transaction, with an idempotent retry queue.

The stored payload supports recovery after closing the browser and comparison of extracted versus reviewed values. Abandoned drafts expire; explicitly discarded drafts are invalidated immediately. Historical confirmed proofs are never swept merely because an old draft expired.

Regression tests cover refresh/reopen, stale edits, confirmation versus discard/expiry races, repeated confirmation, schema changes during review, deletion failures, and retention of confirmed proofs.
