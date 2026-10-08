import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const temp = mkdtempSync(join(tmpdir(), 'rally-browser-'));
process.env.DATABASE_PATH = join(temp, 'e2e.db');
process.env.UPLOAD_DIR = join(temp, 'proofs');
process.env.DEMO_DIR = join(temp, 'demos');
process.env.ADMIN_PASSCODE = '6bfZQp8mJr5VvL9aT2cXH7nW';
process.env.HOST = '127.0.0.1';
process.env.PORT = '4329';
const { sqlite } = await import('../src/db/index.ts');
const { migrateDatabase } = await import('../src/db/migrate.ts');
migrateDatabase(sqlite);
const { newSession } = await import('../src/lib/auth.ts');
if (!process.env.E2E_ADMIN_SESSION_FILE) throw new Error('Missing browser session fixture path.');
writeFileSync(process.env.E2E_ADMIN_SESSION_FILE, JSON.stringify({ token: newSession() }), {
  mode: 0o600,
});
// This provider is only used by the browser test. No external API calls are made.
const mockReportTimestamp = new Date().toISOString();
const mockReportDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Chicago' }).format(
  new Date(mockReportTimestamp),
);
const vision = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (!body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,')) {
    res.writeHead(400);
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  const discovery = body.messages[0].content.startsWith('Inspect');
  const configuration = discovery
    ? null
    : JSON.parse(body.messages[1].content[0].text.split('Configuration: ')[1]);
  const result = discovery
    ? {
        identifier_label: 'Cashier No',
        metrics: [
          { label: 'Number Sold', source_column: 'Number Sold', type: 'decimal', precision: 2 },
          {
            label: 'Dollars Sold',
            source_column: 'Dollars Sold',
            type: 'currency',
            precision: 2,
            currency: 'USD',
          },
        ],
      }
    : {
        contract_version: 1,
        item_code: '0004011',
        generated_at: mockReportTimestamp,
        period_start: mockReportDay,
        period_end: mockReportDay,
        rows: [
          {
            participant_id: '119',
            values: Object.fromEntries(
              configuration.metrics.map((m, i) => [m.key, i === 0 ? '250' : '125.00']),
            ),
          },
        ],
      };
  res.end(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    }),
  );
});
await new Promise((resolve) => vision.listen(0, '127.0.0.1', resolve));
process.env.VISION_BASE_URL = `http://127.0.0.1:${vision.address().port}/v1`;
process.env.VISION_MODEL = 'test-vision';
const child = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', env: process.env });
const cleanup = () => {
  rmSync(process.env.E2E_ADMIN_SESSION_FILE, { force: true });
  vision.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
};
child.once('exit', (code) => {
  cleanup();
  process.exit(code || 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill('SIGTERM'));
