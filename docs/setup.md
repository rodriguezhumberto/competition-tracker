# Setup and deployment

See the [README](../README.md) for local setup. Node.js 24 or newer is required.

## Configuration

Copy `.env.example` to `.env` and set a private `ADMIN_PASSCODE`. Generate one with:

```sh
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

Production startup requires 16–256 characters and rejects known examples,
repeated patterns, whitespace at the ends, and control characters. The compiled
server defaults to production mode. Use `npm run dev` for development.

| Variable              | Purpose / default                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_PASSCODE`      | Required private admin passcode. Production requires 16–256 characters.                                                                 |
| `HOST`, `PORT`        | `0.0.0.0`, `4321` in `.env.example`.                                                                                                    |
| `PRODUCTION_HOSTNAME` | Required real HTTPS hostname for Docker builds. Empty for local HTTP builds. Rebuild after changing it.                                 |
| `DATABASE_PATH`       | SQLite path, default `./sqlite.db`. Also used by Drizzle Kit.                                                                           |
| `UPLOAD_DIR`          | Protected proofs, default `./data/proofs`.                                                                                              |
| `DEMO_DIR`            | Demo storage, default `./data/demos`.                                                                                                   |
| `DEMO_ENABLED`        | Default `true`. Set `false` to disable demos.                                                                                           |
| `VISION_BASE_URL`     | OpenAI-compatible `/v1` URL or full `/chat/completions` endpoint.                                                                       |
| `VISION_MODEL`        | Exact vision-capable model supported by the provider.                                                                                   |
| `VISION_API_KEY`      | Provider key. Also accepts `OPENAI_API_KEY`.                                                                                            |
| `TESSERACT_PATH`      | Orientation executable, default `tesseract` on PATH.                                                                                    |
| `TRUSTED_PROXY_IPS`   | Optional comma-separated exact proxy peer IPs for WebSocket visitor quotas. Empty by default. Untrusted forwarding headers are ignored. |
| `TESSDATA_PREFIX`     | Optional custom Tesseract data directory.                                                                                               |

For OpenAI, use `https://api.openai.com/v1` with a model and key. For local Ollama, use `http://localhost:11434/v1`, an installed vision-capable model, and an empty key.

Optional local orientation detection requires Tesseract 5 and `osd.traineddata`:

```sh
# macOS
brew install tesseract
# Debian / Ubuntu
apt-get install tesseract-ocr tesseract-ocr-osd
# Output must include osd.
tesseract --list-langs
```

Manual rotation remains available without Tesseract.

## Production

For container builds and runtime requirements, see [Deployment](deployment.md).

Set your real `PRODUCTION_HOSTNAME` in `.env` or the environment before building
for HTTPS. Local builds that omit it only trust HTTP localhost.

Demo join links and QR codes use `https://PRODUCTION_HOSTNAME` when that hostname
is set at build time. The domain is included in the compiled app, so the Docker
runtime does not need to supply it again. Rebuild after changing the domain.
For local HTTP deployment, leave `PRODUCTION_HOSTNAME` empty before building;
invitations use the current request's address and port (for example,
`http://localhost:4321/demo?room=…&invite=…`). A localhost invitation opens on
the same computer; another device needs a reachable server address.

```sh
npm run build
npm run db:migrate
npm start
```

Use `npm start`: the custom `server.mjs` entrypoint attaches WebSockets to the HTTP server. Deploy `dist/`, `src/`, `scripts/`, `drizzle/`, `server.mjs`, package files, and installed production dependencies.

Run one Node process and persist the database, WAL files, proofs, and demo storage.
Run migrations before starting an upgraded release. Admin sessions last 12 hours,
survive restarts, and are revoked on logout or passcode change. Revocation also
closes the admin WebSocket. Legacy cookies require a new login after upgrading.

## Browser and WebSocket protections

Iframe embedding is blocked. Responses set `nosniff`, a referrer policy, and CSP
restrictions on framing, base URLs, objects, and form destinations. Script/style
restrictions need an Alpine-compatible frontend migration.

WebSocket limits are 512 connections overall, 128 per peer, and a 256 KiB send
buffer. Heartbeats run every 30 seconds. Floods and repeated invalid messages
disconnect.

Without `TRUSTED_PROXY_IPS`, everyone behind a proxy shares its 128-connection
quota. Trusted peers must send the expected hostname, HTTPS scheme, and a single
visitor IP. Configure connection limits at the proxy too. Shared NAT visitors
share quotas.

## Site privacy

Standings are public by default. To protect them, enable **Require a password to
view the site** under **Site privacy** in admin and set an 8–128-character password.
This persists in the database and does not grant admin access.

Viewer sessions last 12 hours. Changing the password or selecting **Sign out all
viewers** revokes them. Leave the password blank to keep it. Disabling protection
makes the site public immediately.

On a protected site, signed-in viewers join Power Hours with their name. On a
public site, they also need the session password. Always set that password when
creating a session in case site protection changes. Demos stay public and isolated
from production data.

## Privacy policy and retention

`/privacy` and `/disclaimer` remain public. Set `SITE_OPERATOR_NAME` and
`PRIVACY_CONTACT_EMAIL` to identify the operator. The policy currently describes
an installation in Texas, United States. Review it for your location and providers.

Cleanup runs at startup and every minute:

| Data                                        | Deletion deadline                               |
| ------------------------------------------- | ----------------------------------------------- |
| Saved proof images and processing artifacts | 15 days after the competition ends              |
| Identifiable report data and results        | 30 days after the competition ends              |
| Unsaved drafts                              | 24 hours after extraction                       |
| Standalone Power Hour data                  | 30 days after the session ends                  |
| Competition-linked Power Hour data          | 30 days after the later session/competition end |

Competition deadlines start at midnight after the final date in its timezone and
use elapsed 24-hour days. Archiving or an active flag does not change them.
Competition definitions remain. Participant names are deleted once no retained
session references them.

Expired proofs become inaccessible immediately. The cleanup queue removes their
files and retries failures, up to 100 items per minute. Report draft payloads are
scrubbed at the competition's 30-day deadline even if file deletion fails.

Backups, logs, exports, and provider copies need separate retention policies.
Restores must run startup cleanup before reopening the site.

## Database updates

Run `npm run db:migrate` for fresh installs and upgrades. Create competitions with
the admin widget. Migrations run transactionally and check checksums, schema, and
foreign keys. Add new migrations without editing those already deployed.

Back up the database and proofs while writes are stopped, migrate, then start the
updated app. Predeployment databases and unmanaged schemas are unsupported.
