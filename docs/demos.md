# Interactive demos

Choose **Launch demo** in the admin page to open a fresh, isolated workspace in presenter mode. It includes eight fictional participants, three metrics, five days of reports, and a completed Power Hour. Live product data remains untouched; demos do not call report extraction or paid vision APIs.

## Running a presentation

Start a five-minute Power Hour and join with your name to score alongside simulated competitors. The demo uses the product's layout, filters, scoring controls, theme switcher, and archives.

Open **Demo controls** → **Present to a group** for an audience link, QR code, and pause/resume controls. Invitees can watch and join; only the host can start, extend, end, reset, or trigger review flags. Eight seats are reserved for simulated users, leaving twelve for real participants.

Pausing stops simulated points while the countdown continues. Mode changes preserve data and the invite. **Reset my demo** restores sample data while retaining workspace access.

The host's `/demo/admin` includes the four-step competition wizard and normal activation/editing screens. Create a competition manually or reuse the sample template. Audience invites cannot manage competitions; sample-image discovery is unavailable.

## Persistence and limits

- Simulations run on the server and pages poll once per second. After a restart, opening the workspace resumes its runner and skips overdue points.
- Workspaces expire after two hours without browser requests; cleanup runs every minute. At most 100 workspaces exist, with ten creation attempts per client address per ten minutes.
- Host/participant credentials use HttpOnly cookies. Audience links grant no live-site admin access.
- Leaderboards, report activity, and archives render without JavaScript; simulation controls require it.

Use the normal launch commands and single-process deployment. Demo databases use the existing migration runner and add no production migration. Persist `DEMO_DIR` for restart recovery, keep it separate from the production database, or set `DEMO_ENABLED=false` to disable demos. See [configuration](setup.md#configuration).
