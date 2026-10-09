import { authenticateAdmin } from './helpers/admin.ts';
import { ensureReportCompetition } from './helpers/reports.ts';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#fff' } })
  .png()
  .toBuffer();
const file = { name: 'orientation.png', mimeType: 'image/png', buffer: image };
async function login(page: import('@playwright/test').Page) {
  await authenticateAdmin(page);
  await page.goto('/admin');
  await ensureReportCompetition(page);
}

test('automatic rotation, uncertain suggestions, unavailable detection and manual override', async ({
  page,
}) => {
  let result = {
    status: 'confident',
    rotation: 270 as number | null,
    confidence: 20 as number | null,
    reason: 'detected',
  };
  await page.route('**/api/orientation', (route) => route.fulfill({ json: result }));
  await login(page);
  const upload = page.locator('.report-upload[data-report-workflow=competition]');
  const orientation = upload.getByRole('status', { name: 'Report image orientation' });
  const detection = upload.getByRole('status', { name: 'Automatic orientation detection' });
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(detection).toContainText('Automatically rotated');
  await expect(orientation).toHaveText('Rotation: 270°');
  await expect
    .poll(() =>
      upload
        .getByAltText('Report orientation preview')
        .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
    )
    .toEqual([80, 120]);
  const uploadResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/upload') && r.request().method() === 'POST',
  );
  await upload.getByRole('button', { name: 'Scan & preview' }).click();
  const draft = await (await uploadResponse).json();
  expect(draft.processing).toMatchObject({ rotation: 270, width: 80, height: 120 });
  const proof = await page.request.get(`/api/proof?draft=${draft.token}&variant=processed`);
  const dimensions = await sharp(await proof.body()).metadata();
  expect([dimensions.width, dimensions.height]).toEqual([80, 120]);
  await upload.getByRole('button', { name: 'Discard preview' }).click();
  await upload.getByRole('button', { name: 'Rotate right' }).click();
  await expect(orientation).toHaveText('Rotation: 0°');
  result = { status: 'uncertain', rotation: 90, confidence: 4, reason: 'low_confidence' };
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(detection).toContainText('uncertain');
  await expect(orientation).toHaveText('Rotation: 0°');
  await upload.getByRole('button', { name: 'Use suggested rotation (90°)' }).click();
  await expect(orientation).toHaveText('Rotation: 90°');
  result = { status: 'unavailable', rotation: null, confidence: null, reason: 'unavailable' };
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(detection).toContainText('rotate manually');
  await expect(orientation).toHaveText('Rotation: 0°');
  await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeEnabled();
  await upload.getByRole('button', { name: 'Rotate left' }).click();
  await expect(orientation).toHaveText('Rotation: 270°');
});

test('late detection never overrides manual rotation or a replacement file', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/orientation', async (route) => {
    const request = ++requests;
    await new Promise((resolve) => setTimeout(resolve, request === 1 ? 600 : 50));
    await route.fulfill({
      json: {
        status: 'confident',
        rotation: request === 1 ? 180 : 0,
        confidence: 20,
        reason: 'detected',
      },
    });
  });
  await login(page);
  const upload = page.locator('.report-upload[data-report-workflow=competition]');
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(
    upload.getByRole('status', { name: 'Automatic orientation detection' }),
  ).toContainText('Checking');
  await upload.getByRole('button', { name: 'Rotate right' }).click();
  await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
    'Rotation: 90°',
  );
  await expect(upload.getByRole('status', { name: 'Automatic orientation detection' })).toHaveText(
    'Manual rotation selected.',
  );
  await page.waitForTimeout(700);
  await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
    'Rotation: 90°',
  );
  requests = 0;
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(
    upload.getByRole('status', { name: 'Automatic orientation detection' }),
  ).toContainText('Checking');
  await upload.locator('input[type=file]').setInputFiles({ ...file, name: 'replacement.png' });
  await expect(
    upload.getByRole('status', { name: 'Automatic orientation detection' }),
  ).toContainText('appears upright');
  await page.waitForTimeout(700);
  await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
    'Rotation: 0°',
  );
});

test('orientation endpoint requires an admin and same-origin requests, and rejects invalid images', async ({
  page,
  request,
}) => {
  expect((await request.post('/api/orientation')).status()).toBe(403);
  await login(page);
  expect((await page.request.post('/api/orientation')).status()).toBe(403);
  const origin = { Origin: 'http://127.0.0.1:4329' };
  expect(
    (
      await page.request.post('/api/orientation', {
        headers: origin,
        multipart: {
          report: { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('bad image') },
        },
      })
    ).status(),
  ).toBe(400);
});
