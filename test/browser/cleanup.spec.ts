import { test, expect } from '@playwright/test';
import { newMetric } from '../../src/lib/metrics.ts';
import { authenticateAdmin } from './helpers/admin.ts';

test('activity pages stay bounded and private metrics never reach public history', async ({
  page,
  browser,
}) => {
  await authenticateAdmin(page);
  const origin = { Origin: 'http://127.0.0.1:4329' };
  const timestamp = new Date(Date.now() - 1000).toISOString();
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Chicago' }).format(
    new Date(timestamp),
  );
  const created = await page.request.post('/api/competition', {
    headers: origin,
    form: {
      payload: JSON.stringify({
        name: 'Activity pagination',
        start_date: day,
        end_date: day,
        is_active: true,
        metrics: [
          { ...newMetric(), label: 'Points' },
          { ...newMetric('private_value'), label: 'Secret revenue', public: false },
        ],
      }),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  const saved = await page.request.post('/api/reports', {
    headers: origin,
    form: {
      payload: JSON.stringify({
        competition_id: id,
        schema_version: 1,
        confirmed: true,
        report: {
          generated_at: timestamp,
          period_start: day,
          period_end: day,
          rows: Array.from({ length: 25 }, (_, index) => ({
            participant_id: String(100 + index),
            values: { metric_1: String(index), private_value: '9876.54' },
          })),
        },
      }),
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  // SSR history must remain navigable without JavaScript.
  const visitor = await browser.newContext({ javaScriptEnabled: false });
  try {
    const publicPage = await visitor.newPage();
    await publicPage.goto('/');
    await expect(publicPage.locator('.compact-update')).toHaveCount(12);
    await publicPage.getByRole('link', { name: 'View report activity' }).click();
    await expect(publicPage.locator('.activity-item')).toHaveCount(20);
    expect(await publicPage.content()).not.toContain('Secret revenue');
    expect(await publicPage.content()).not.toContain('9876.54');
    await publicPage.getByRole('link', { name: 'Older reports' }).click();
    await expect(publicPage.locator('.activity-item')).toHaveCount(5);
    await expect(publicPage.getByRole('link', { name: 'Older reports' })).toHaveCount(0);
    await publicPage.getByRole('link', { name: 'Newer reports' }).click();
    await expect(publicPage.locator('.activity-item')).toHaveCount(20);
    await publicPage.goto('/activity?metric=private_value');
    expect(await publicPage.content()).not.toContain('Secret revenue');
  } finally {
    await visitor.close();
  }
});

test('public pages skip admin JavaScript while admin forms initialize normally', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('[data-compact-standings]')).toHaveCount(1);
  expect(scripts.some((url) => url.includes('admin-client'))).toBe(false);
  await authenticateAdmin(page);
  await page.goto('/admin');
  await expect(
    page.locator('.competition-editor').getByRole('button', { name: 'Continue', exact: true }),
  ).toBeVisible();
  expect(scripts.some((url) => url.includes('admin-client'))).toBe(true);
  const entry = page.locator('.manual-report');
  await expect(entry.locator('tbody tr')).toHaveCount(1);
  await entry.getByRole('button', { name: 'Add participant row' }).click();
  await expect(entry.locator('tbody tr')).toHaveCount(2);
});
