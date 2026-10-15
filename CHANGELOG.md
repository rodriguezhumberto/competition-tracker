# Changelog

## 1.2.0 — 2026-10-14

### Added

- Scanned report reviews show live totals for each metric, with incomplete totals flagged when cells are missing or invalid.

## 1.1.4 — 2026-10-14

### Fixed

- Successful uploads clear the selected image and adjustments; failed submissions retain them for retry.
- Reserved preview space and position restoration reduce page jumps during mobile upload, OCR, and confirmation. Subsequent Power Hour reports update in place, including report history and standings.

## 1.1.3 — 2026-10-14

### Fixed

- Baseline upload headings and labels remain readable inside the admin Power Hour panel in both themes.

## 1.1.2 — 2026-10-12

### Fixed

- Operators missing from a Power Hour item's baseline start at zero when they first appear in a later report.
- Report timestamps use a date/time picker in the competition timezone.
- Subsequent Power Hour reports reuse the reviewed baseline period, including reports for additional PLUs, while retaining their printed generation time.
- Additional PLU baselines can be printed before the first baseline without changing the Power Hour timer or awarding points.

## 1.1.1 — 2026-10-09

### Fixed

- Report-driven Power Hours stay open for final uploads after the countdown ends. Participants see provisional standings until the admin publishes final results.
- Reports printed more than five minutes after the cutoff show a warning and can still be accepted. Published results are locked.

## 1.1.0 — 2026-10-09

### Added

- Report-driven Power Hours with reviewed admin uploads, per-PLU baselines, combined scoring, and a read-only leaderboard.
- Power Hour report history and confirmation of in-window reports after the countdown ends.

### Fixed

- Power Hour reports for different PLUs can arrive out of timestamp order; duplicate and older reports are rejected per PLU.

## 1.0.0 — 2026-10-08

Initial version:

- Competition creation with configurable metrics and support for multiple tracked items.
- Report image imports with manual review, saved drafts, and image adjustments.
- Live Power Hours with mobile participation and archived results.
- Isolated demos with presenter controls and invitation links.
- Optional viewer protection, revocable admin sessions, and automatic data retention.
- Docker packaging and versioned database migrations.
