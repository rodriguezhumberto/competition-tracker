# Competition Tracker

A leaderboard for competition reports and live Power Hours.

Created to simplify competition tracking at work, replacing pen and paper tracking with a web app.
Power Hours encourage friendly competition as participants work toward a shared goal.
Configurable metrics let each competition track what matters to its participants.

Uses Astro, SQLite, Alpine, and WebSockets.

## Quick start

Requires Node.js 24 or newer.

```sh
npm ci
cp .env.example .env
# Set ADMIN_PASSCODE in .env.
npm run db:migrate
npm run dev
```

Open [localhost:4321](http://localhost:4321) and sign in at `/admin` to create a competition or start a Power Hour. Participants join Power Hours from the main page using the shared password and their name.

For sample data, run `npm run db:seed` on an empty database. To try an isolated interactive workspace, choose **Launch demo** in the admin page.

## Documentation

- [Setup and deployment](docs/setup.md) — configuration, production hosting, and migrations.
- [Deployment](docs/deployment.md) — Docker builds, runtime requirements, and upgrades.
- [Competition rules](docs/competition-rules.md) — metrics, report dates, rankings, and Power Hours.
- [Report processing](docs/report-processing.md) — reviewed imports, image preparation, and extraction.
- [Demos](docs/demos.md) — simulation controls and group presentations.
- [Development](docs/development.md) — code entry points and verification commands.

## AI Disclosure

Developed with assistance from a coding harness.
