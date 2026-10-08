import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
if (!process.env.E2E_ADMIN_SESSION_FILE) {
  const sessionDirectory = mkdtempSync(join(tmpdir(), 'rally-e2e-admin-'));
  process.env.E2E_ADMIN_SESSION_FILE = join(sessionDirectory, 'session.json');
  process.once('exit', () => rmSync(sessionDirectory, { recursive: true, force: true }));
}
export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4329', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4329',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
