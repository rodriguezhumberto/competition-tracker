# Deployment

The Docker image includes the app, Tesseract, and the database migration runner.

For hosting without Docker, see [Setup](setup.md#production).

## Build

Set `PRODUCTION_HOSTNAME` to your real hostname, then build:

```sh
docker build --build-arg PRODUCTION_HOSTNAME="${PRODUCTION_HOSTNAME:?Set your hostname}" \
  -t competition-tracker:RELEASE .
```

Use a commit SHA or release tag. Build for the target machine’s architecture.
Docker rejects missing and example hostnames. Changing the hostname requires a
rebuild because Astro compiles its trusted hosts into the server.

The same build-time hostname sets the public HTTPS address for demo invitation
links and QR codes. No additional invitation-domain variable is required at runtime.

## Runtime

| Setting        | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Process        | One app container per database, running `node server.mjs`     |
| Port           | `4321`, exposed only to localhost or the Docker proxy network |
| User           | UID/GID `1000:1000`                                           |
| Storage        | Persistent `/data` mount, writable by UID/GID 1000            |
| Database       | `/data/sqlite.db` and its WAL/SHM files                       |
| Proofs / demos | `/data/proofs` and `/data/demos`                              |
| Migration      | `node scripts/migrate.mjs`                                    |

Supply a generated `ADMIN_PASSCODE` and provider settings through the runtime
configuration. Production rejects weak or example passcodes. See
[configuration](setup.md#configuration) for all variables.

Keep the same `/data` mount across releases. Local `.env` storage paths can
override the image defaults and leave data outside that mount. A provider on the
host or another container needs a reachable address, not `localhost`.

A reverse proxy must forward the public Host and HTTPS scheme and support
WebSocket upgrades at `/ws`. Reach the app through a shared Docker network or a
localhost port binding. Allow 30 seconds for shutdown.

## Upgrades

1. Build the new image and validate its runtime configuration.
2. Stop the app and back up its database and proofs together.
3. Run `node scripts/migrate.mjs` in the new image with the existing `/data` mount.
4. Start the new image with that same mount and runtime configuration.

Migrations do not run on container restart. If migration fails, keep the app
stopped until resolved. Never run two app containers against the same database.

After deployment, check admin login, report processing, and a live Power Hour
through the HTTPS URL. Upgrading to revocable admin sessions requires a new login.

## Backups and rollback

Back up the database and proofs together. Stop writes before copying SQLite
files, or use a SQLite-aware backup.

Rollback may require the old image and its matching database/proof backup. A
restore loses writes made after that backup. Startup runs retention cleanup, so
check the logs before reopening traffic.
