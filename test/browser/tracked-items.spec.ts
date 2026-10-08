import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { authenticateAdmin } from './helpers/admin.ts';
import { centralDate } from '../../src/lib/central-time.ts';

async function createCompetition(
  page: Page,
  name: string,
  items: { code: string; name: string }[],
) {
  await authenticateAdmin(page);
  await page.goto('/admin');
  const editor = page.locator('.competition-editor');
  await editor.getByLabel('Competition name').fill(name);
  await editor.getByLabel('Start date', { exact: true }).fill(centralDate(Date.now() - 86400000));
  await editor.getByLabel('End date', { exact: true }).fill(centralDate(Date.now() + 86400000));
  await editor.getByLabel('Make this the active competition').check();
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByLabel('Track multiple items').check();
  await editor.getByLabel('Item label').fill('Product');
  for (const item of items) {
    await editor.getByRole('button', { name: 'Add item', exact: true }).click();
    await editor.getByLabel('Item name', { exact: true }).last().fill(item.name);
    await editor.getByLabel('Report code', { exact: true }).last().fill(item.code);
  }
  await editor.getByLabel('Metric label', { exact: true }).fill('Number Sold');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByRole('button', { name: 'Create competition', exact: true }).click();
  await expect(page).toHaveURL(/\/competitions\/\d+/);
  return new URL(page.url()).pathname;
}

test('multiple-item setup and manual reports retain separate baselines and filter standings and exports', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const path = await createCompetition(page, 'Multiple item scores', [
    { code: '0004011', name: 'Product A' },
    { code: '0004012', name: 'Product B' },
  ]);
  await page.goto('/admin');
  const manual = page.locator('.manual-report');
  const first = new Date(Date.now() - 120000).toISOString();
  const later = new Date(Date.now() - 60000).toISOString();
  const save = async (code: string, timestamp: string, value: string) => {
    await manual.getByLabel('Tracked item').selectOption(code);
    await manual.getByLabel('Report generation time').fill(timestamp);
    const day = centralDate(new Date(timestamp));
    await manual.getByLabel('Period start', { exact: true }).fill(day);
    await manual.getByLabel('Period end', { exact: true }).fill(day);
    await manual.getByLabel('Operator number row 1', { exact: true }).fill('00119');
    await manual.getByLabel('Number Sold row 1', { exact: true }).fill(value);
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/reports') && r.request().method() === 'POST',
    );
    await manual.getByRole('button', { name: 'Save batch report' }).click();
    const result = await response;
    expect(result.ok(), await result.text()).toBe(true);
    await expect(manual.locator('[role=status]')).toContainText('Report saved');
  };
  await save('0004011', first, '10');
  await save('0004012', first, '6');
  await save('0004011', later, '12');
  await page.goto(path);
  await expect(page.locator('.multi-metric-table tbody')).toContainText('00119');
  await expect(page.locator('.multi-metric-table tbody')).toContainText('18');
  await page.getByLabel('Filter by item').selectOption('0004012');
  await expect(page).toHaveURL(/item=0004012/);
  await expect(page.locator('.multi-metric-table tbody')).toContainText('6');
  const csvLink = page.getByRole('link', { name: 'Download CSV' });
  await expect(csvLink).toHaveAttribute('href', /item=0004012/);
  const csv = await page.request.get((await csvLink.getAttribute('href'))!);
  expect(csv.ok()).toBe(true);
  expect(await csv.text()).toContain('Product B');
  await page.getByLabel('Time period').selectOption('week');
  await expect(page).toHaveURL(/item=0004012/);
  await expect(page.locator('.multi-metric-table tbody')).toContainText('6');
  await page.goto('/?item=0004011');
  await expect(page.getByLabel('Filter by item')).toHaveValue('0004011');
  await expect(page.locator('.compact-column').first()).toContainText('12');
  await page.getByLabel('Filter by item').selectOption('0004012');
  await expect(page).toHaveURL(/item=0004012/);
  await expect(page.locator('.compact-column').first()).toContainText('6');
  await page.getByLabel('Time period').selectOption('day');
  await expect(page.getByLabel('Filter by item')).toHaveValue('0004012');
  await expect(page.getByRole('link', { name: 'View report activity →' })).toHaveAttribute(
    'href',
    /item=0004012/,
  );
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  const invalid = await page.request.get('/?item=unknown');
  expect(invalid.status()).toBe(400);
  expect(await invalid.text()).toContain('All items');
  expect(errors).toEqual([]);
});

test('unrecognized report codes require review and adding an item preserves edited draft values', async ({
  page,
}) => {
  const path = await createCompetition(page, 'Review item discovery', [
    { code: '0009999', name: 'Other product' },
  ]);
  await page.goto('/admin');
  const upload = page.locator('.report-upload');
  const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  await upload
    .locator('input[type=file]')
    .setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: image });
  await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeEnabled();
  await upload.getByRole('button', { name: 'Scan & preview' }).click();
  await expect(upload.getByRole('heading', { name: 'Review extracted report' })).toBeVisible();
  await expect(upload.getByLabel('Tracked item')).toHaveValue('');
  await expect(upload).toContainText('0004011');
  await expect(upload.getByRole('button', { name: 'Confirm & save report' })).toBeDisabled();
  await upload.getByLabel('Number Sold row 1').fill('7.25');
  await upload.getByRole('button', { name: 'Add a new tracked item' }).click();
  await upload.getByLabel('Item name', { exact: true }).fill('Detected product');
  await upload.getByLabel('Report code', { exact: true }).fill('0004011');
  await upload.getByRole('button', { name: 'Add item to competition' }).click();
  await expect(upload.getByLabel('Tracked item')).toHaveValue('0004011');
  await expect(upload.getByLabel('Number Sold row 1')).toHaveValue('7.25');
  await upload.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(upload.locator('.notice[role=status]')).toContainText('Draft saved');
  await page.reload();
  await expect(upload.getByLabel('Tracked item')).toHaveValue('0004011');
  await expect(upload.getByLabel('Number Sold row 1')).toHaveValue('7.25');
  await upload.getByLabel('I checked the dates and values against the source report.').check();
  await upload.getByRole('button', { name: 'Confirm & save report' }).click();
  await expect(upload.locator('.notice[role=status]')).toContainText('Report saved');
  await page.goto(path + '?item=0004011');
  await expect(page.locator('.multi-metric-table tbody')).toContainText('7.25');
  await expect(page.getByLabel('Filter by item')).toHaveValue('0004011');
});
