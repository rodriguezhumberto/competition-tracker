import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

// Image/cleanup tests need an authenticated fixture, not another login attempt.
// app.spec.ts exercises the real login form; metrics.spec.ts checks forged cookies.
export async function authenticateAdmin(page: Page) {
  const { token } = JSON.parse(readFileSync(process.env.E2E_ADMIN_SESSION_FILE!, 'utf8'));
  await page.context().addCookies([
    {
      name: 'admin',
      value: token,
      url: 'http://127.0.0.1:4329',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}
