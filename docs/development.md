# Development

## Code entry points

| Area                                    | Location                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Schema and migrations                   | `src/db/schema.ts`, `src/db/migrate.ts`, `drizzle/`                                        |
| Competition configuration and standings | Competition store facade, report validation/storage, and leaderboard modules in `src/lib/` |
| Time handling                           | `src/lib/time.ts`, `calendar.ts`                                                           |
| Vision transport and extraction         | `src/lib/vision-provider.ts`, `src/lib/vision.ts`                                          |
| Shared image preparation                | `src/lib/report-image.ts`                                                                  |
| HTTP and WebSocket entrypoint           | `server.mjs`                                                                               |

Report validation and insertion share an `IMMEDIATE` transaction. Power Hour increments use atomic upserts. SQLite uses WAL, foreign keys, unique indexes, and a busy timeout. Metric values and contributions are stored as scaled integers in `report_values`. Entries link participants to their reports.

WebSocket events are `power_hour_started`, `scores_updated`, and `power_hour_ended`. Taps send `{ action: "increment", sessionId }`. The server resolves the participant from its browser credential.

Admin forms and the image editor load dynamically on relevant pages before Alpine initialization. [Report processing](report-processing.md) describes extraction and image contracts. [Implemented review changes](review-proposals.md) records time-utility and draft-lifecycle details.

## Schema changes

After editing `src/db/schema.ts`, run `npm run db:generate`. Review and commit the SQL, snapshot, and journal together. Add a new migration rather than editing one already applied. App upgrades and tests use the same migration runner. See [database updates](setup.md#database-updates).

## Verification

```sh
npm run format:check
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

Use `npm run format` to format source files with Prettier and the Astro plugin.

Core tests cover scoring, validation, migrations, concurrent writes, drafts, image processing, demos, and socket authorization. Browser tests use a temporary database and mock vision provider, covering admin flows, reviewed imports, private-data exclusion, live sessions, archives, responsive layout, and rendering without JavaScript. They do not call paid APIs. A real provider needs a separate live test.

`npm run test:e2e` gives each test file a fresh server and database so Power Hour
sessions, privacy settings, and rate limits do not leak between suites. To run a selected file, use
`npm run test:e2e -- test/browser/demo.spec.ts`.

Native orientation checks skip when Tesseract/OSD is unavailable. Representative real reports still need validation for orientation confidence and page-boundary suggestions.
