import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { authenticateAdmin } from './helpers/admin.ts';
import { centralDate } from '../../src/lib/central-time.ts';
import { newMetric } from '../../src/lib/metrics.ts';
import { pickerClock } from '../../src/lib/report-clock-client.ts';

test('reviewed PLU reports start a view-only Power Hour and aggregate independently ordered updates', async ({
  page,
  browser,
}) => {
  await authenticateAdmin(page);
  await page.route('**/api/orientation', (route) =>
    route.fulfill({
      json: { status: 'confident', rotation: 0, confidence: 20, reason: 'detected' },
    }),
  );
  let uploadMode = '';
  await page.route('**/api/upload', async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    if (response.ok() && uploadMode === 'power-hour') {
      result.report.period_start = null;
      result.report.period_end = '1900-01-01';
    }
    await route.fulfill({ response, json: result });
  });
  await page.goto('/admin');
  const now = Date.now();
  const day = centralDate(now);
  const origin = new URL(page.url()).origin;
  const created = await page.request.post('/api/competition', {
    headers: { Origin: origin },
    form: {
      payload: JSON.stringify({
        name: 'Report race format',
        start_date: day,
        end_date: day,
        timezone: 'America/Chicago',
        is_active: true,
        multiple_items: true,
        item_label: 'PLU',
        items: [
          { code: '0004011', name: 'First PLU' },
          { code: '0004012', name: 'Second PLU' },
        ],
        metrics: [{ ...newMetric('quantity'), label: 'Number Sold' }],
        profile: { identifier_label: 'Cashier No', columns: { quantity: 'Number Sold' } },
      }),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.reload();
  await page.getByRole('switch', { name: 'Use admin-uploaded reports' }).check();
  await expect(page.getByLabel('Shared password', { exact: true })).not.toBeVisible();
  const buffer = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  async function scan(mode: string, code: string, minutesAgo: number, value: string) {
    uploadMode = mode;
    const upload = page.locator(`[data-report-workflow="${mode}"]`);
    await upload
      .locator('input[type=file]')
      .setInputFiles({ name: 'report.png', mimeType: 'image/png', buffer });
    await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeEnabled();
    await upload.getByRole('button', { name: 'Scan & preview' }).click();
    await expect(upload.getByRole('heading', { name: 'Review extracted report' })).toBeVisible();
    if (mode === 'power-hour') {
      await expect(upload.getByLabel('Period start', { exact: true })).toHaveValue(day);
      await expect(upload.getByLabel('Period end', { exact: true })).toHaveValue(day);
      await expect(upload.getByLabel('Period start', { exact: true })).toHaveJSProperty(
        'readOnly',
        true,
      );
      await expect(upload.getByLabel('Period end', { exact: true })).toHaveJSProperty(
        'readOnly',
        true,
      );
    }
    await upload.getByLabel('Tracked item').selectOption(code);
    await upload
      .getByLabel('Report generation time')
      .fill(pickerClock(new Date(now - minutesAgo * 60000).toISOString(), 'America/Chicago'));
    await upload.getByLabel('Number Sold row 1').fill(value);
    await upload.getByLabel('I checked the dates and values against the source report.').check();
    return upload;
  }
  const baseline = await scan('baseline', '0004011', 5, '10');
  await baseline.getByLabel('Power Hour name', { exact: true }).fill('Report race');
  await baseline.getByRole('button', { name: 'Start Power Hour', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Report race is live.' })).toBeVisible();
  const viewer = await browser.newContext();
  const lobby = await viewer.newPage();
  try {
    await lobby.goto('/');
    await expect(lobby.locator('.power-hour-live')).toBeVisible();
    await expect(lobby.locator('.power-hour-join')).not.toBeVisible();
    await expect(lobby.locator('.tap-button')).toHaveCount(0);
    await expect(lobby.getByText('No progress yet.', { exact: true })).toBeVisible();
    async function confirm(code: string, minutesAgo: number, value: string) {
      const upload = await scan('power-hour', code, minutesAgo, value);
      await upload.getByRole('button', { name: 'Confirm update', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Report race is live.' })).toBeVisible();
      await expect(page.locator('[data-report-workflow="power-hour"] .report-preview')).toHaveCount(
        0,
      );
    }
    await confirm('0004012', 7, '100');
    await expect(lobby.locator('.lobby-rank-row')).toHaveCount(0);
    await confirm('0004011', 2, '12');
    await expect(lobby.locator('.lobby-count')).toHaveText('2.00');
    await confirm('0004012', 3, '103');
    await expect(lobby.locator('.lobby-count')).toHaveText('5.00');
    await expect(page.locator('[aria-label="Power Hour reports"] ol li')).toHaveCount(4);
    await expect(page.locator('.power-hour-admin-leaderboard .score-col strong')).toHaveText(
      '5.00',
    );
    await page.getByRole('button', { name: 'Add time', exact: true }).click();
    await expect
      .poll(async () => parseInt(await lobby.locator('.timer').innerText()))
      .toBeGreaterThanOrEqual(69);
    const ordinary = page.locator('[data-report-workflow="competition"]');
    await expect(ordinary.getByRole('heading', { name: 'Review extracted report' })).toHaveCount(0);
    const ended = await page.request.post('/api/admin', {
      headers: { Origin: origin },
      form: { action: 'archive' },
    });
    expect(ended.ok()).toBe(true);
    await expect(lobby.locator('.timer')).toHaveText('Processing');
    await expect(lobby.locator('.takeover-bar')).toContainText('PROCESSING RESULTS');
    await expect(
      page.getByRole('heading', { name: 'Report race · Awaiting final reports' }),
    ).toBeVisible();
    const final = await scan('power-hour', '0004011', -6, '14');
    await expect(final.getByRole('alert')).toContainText('more than 5 minutes after the cutoff');
    await expect(final.getByRole('button', { name: 'Confirm update', exact: true })).toBeEnabled();
    await final
      .getByLabel('Report generation time')
      .fill(pickerClock(new Date().toISOString(), 'America/Chicago'));
    await expect(
      final.getByRole('alert').filter({ hasText: 'more than 5 minutes' }),
    ).not.toBeVisible();
    await final.getByRole('button', { name: 'Add participant row', exact: true }).click();
    await final.getByLabel('Cashier No row 2', { exact: true }).fill('120');
    await final.getByLabel('Number Sold row 2', { exact: true }).fill('4');
    await final.getByRole('button', { name: 'Confirm update', exact: true }).click();
    await expect(lobby.locator('.lobby-count')).toHaveText(['7.00', '4.00']);
    await page.getByRole('button', { name: 'Publish final results', exact: true }).click();
    await expect(lobby.locator('.timer')).toHaveText('Finished');
    await expect(lobby.locator('.lobby-count')).toHaveText(['7.00', '4.00']);
    await expect(page.locator('[data-report-workflow="power-hour"]')).toHaveCount(0);
    await expect(lobby.locator('.tap-button')).toHaveCount(0);
  } finally {
    await viewer.close();
  }
});
