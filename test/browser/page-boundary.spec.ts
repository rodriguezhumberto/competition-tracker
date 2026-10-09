import { authenticateAdmin } from './helpers/admin.ts';
import { ensureReportCompetition } from './helpers/reports.ts';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
const image = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#444' } })
  .png()
  .toBuffer();
const file = { name: 'page.png', mimeType: 'image/png', buffer: image };
const suggested = {
  status: 'suggested',
  reason: 'page_found',
  crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
};
let adminCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await authenticateAdmin(page);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin$/);
  await ensureReportCompetition(page);
  adminCookies = await context.cookies();
  await context.close();
});
async function prepare(page: import('@playwright/test').Page) {
  await page.route('**/api/orientation', (route) =>
    route.fulfill({
      json: { status: 'confident', rotation: 0, confidence: 20, reason: 'detected' },
    }),
  );
  await page.context().addCookies(adminCookies);
  await page.goto('/admin');
  return page.locator('.report-upload[data-report-workflow=competition]');
}

test('suggested boundaries require review, can be adjusted or dismissed, and reach extraction', async ({
  page,
}) => {
  await page.route('**/api/page-boundary', (route) => route.fulfill({ json: suggested }));
  const upload = await prepare(page);
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(upload.getByRole('status', { name: 'Page boundary suggestion' })).toContainText(
    'whole image is still selected',
  );
  await expect
    .poll(() =>
      upload
        .getByAltText('Report orientation preview')
        .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
    )
    .toEqual([200, 100]);
  await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeEnabled();
  await upload.getByRole('button', { name: 'Keep whole image', exact: true }).click();
  await expect(upload.getByRole('button', { name: 'Review suggested crop' })).toBeHidden();
  await upload.locator('input[type=file]').setInputFiles(file);
  await upload.getByRole('button', { name: 'Review suggested crop' }).click();
  await expect(upload.getByLabel('Crop left (%)')).toHaveValue('10');
  await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeDisabled();
  await upload.getByText('Precise crop adjustments', { exact: true }).click();
  await upload.getByLabel('Crop width (%)').fill('70');
  await upload.getByRole('button', { name: 'Apply crop' }).click();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/upload'));
  await upload.getByRole('button', { name: 'Scan & preview' }).click();
  expect((await (await response).json()).processing.crop).toEqual({
    x: 0.1,
    y: 0.1,
    width: 0.7,
    height: 0.8,
  });
});

test('late suggestions do not replace manual crops or suggestions for a newer rotation', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/api/page-boundary', async (route) => {
    const current = ++requests;
    await new Promise((resolve) => setTimeout(resolve, current === 1 ? 500 : 30));
    await route.fulfill({
      json: current === 1 ? suggested : { status: 'none', crop: null, reason: 'already_framed' },
    });
  });
  const upload = await prepare(page);
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(upload.getByRole('status', { name: 'Page boundary suggestion' })).toContainText(
    'Looking',
  );
  await upload.getByRole('button', { name: 'Crop report', exact: true }).click();
  await page.waitForTimeout(600);
  await expect(upload.getByRole('button', { name: 'Review suggested crop' })).toBeHidden();
  await expect(upload.getByLabel('Crop width (%)')).toHaveValue('100');
  await upload.getByRole('button', { name: 'Cancel crop' }).click();
  requests = 0;
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(upload.getByRole('status', { name: 'Page boundary suggestion' })).toContainText(
    'Looking',
  );
  await upload.getByRole('button', { name: 'Rotate right' }).click();
  await expect(upload.getByRole('status', { name: 'Page boundary suggestion' })).toContainText(
    'already framed',
  );
  await page.waitForTimeout(600);
  await expect(upload.getByRole('button', { name: 'Review suggested crop' })).toBeHidden();
});

test('boundary endpoint rejects unauthenticated, cross-origin and invalid requests', async ({
  page,
  request,
}) => {
  expect((await request.post('/api/page-boundary')).status()).toBe(403);
  await prepare(page);
  expect((await page.request.post('/api/page-boundary')).status()).toBe(403);
  const bad = await page.request.post('/api/page-boundary', {
    headers: { Origin: 'http://127.0.0.1:4329' },
    multipart: {
      report: { name: file.name, mimeType: file.mimeType, buffer: image },
      rotation: '360',
    },
  });
  expect(bad.status()).toBe(400);
});

test('suggestions work for sample discovery and detector failures leave scanning available', async ({
  page,
}) => {
  await page.route('**/api/page-boundary', (route) => route.fulfill({ json: suggested }));
  const upload = await prepare(page);
  const editor = page.locator('.competition-editor');
  await editor.getByLabel('Competition name').fill('Suggested page sample');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByLabel('Sample report (optional)').setInputFiles(file);
  await editor.getByRole('button', { name: 'Review suggested crop' }).click();
  await editor.getByRole('button', { name: 'Apply crop' }).click();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/discover'));
  await editor.getByRole('button', { name: 'Suggest columns from sample' }).click();
  expect((await (await response).json()).processing.crop).toEqual(suggested.crop);
  await page.unroute('**/api/page-boundary');
  await page.route('**/api/page-boundary', (route) => route.abort('failed'));
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(upload.getByRole('status', { name: 'Page boundary suggestion' })).toContainText(
    'unavailable',
  );
  await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeEnabled();
});
