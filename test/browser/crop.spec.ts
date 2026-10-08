import { centralDate } from '../../src/lib/central-time.ts';
import { authenticateAdmin } from './helpers/admin.ts';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { newMetric } from '../../src/lib/metrics.ts';
const image = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } })
  .composite([
    {
      input: await sharp({ create: { width: 40, height: 20, channels: 3, background: '#f00' } })
        .png()
        .toBuffer(),
      left: 40,
      top: 20,
    },
  ])
  .png()
  .toBuffer();
const file = { name: 'crop.png', mimeType: 'image/png', buffer: image };
async function prepare(page: import('@playwright/test').Page) {
  await page.route('**/api/orientation', (route) =>
    route.fulfill({
      json: { status: 'confident', rotation: 0, confidence: 20, reason: 'detected' },
    }),
  );
  await authenticateAdmin(page);
  await page.goto('/admin');
  const upload = page.locator('.report-upload');
  if ((await upload.locator('select option').count()) === 1) {
    const today = centralDate();
    const response = await page.request.post('/api/competition', {
      headers: { Origin: 'http://127.0.0.1:4329' },
      multipart: {
        payload: JSON.stringify({
          name: 'Image adjustment test',
          start_date: today,
          end_date: today,
          timezone: 'America/Chicago',
          is_active: true,
          official_metric_key: 'metric_1',
          metrics: [{ ...newMetric(), label: 'Number Sold' }],
          profile: {
            identifier_label: 'Cashier No',
            identifier_aliases: '',
            date_instructions: '',
            columns: { metric_1: 'Number Sold' },
          },
        }),
      },
    });
    expect(response.ok()).toBe(true);
    await page.reload();
  }
  await upload.locator('input[type=file]').setInputFiles(file);
  await expect(
    upload.getByRole('status', { name: 'Automatic orientation detection' }),
  ).toContainText('upright');
  return upload;
}
async function chooseCrop(container: import('@playwright/test').Locator) {
  await container.getByRole('button', { name: 'Crop report', exact: true }).click();
  await container.getByText('Precise crop adjustments', { exact: true }).click();
  await container.getByLabel('Crop width (%)').fill('50');
  await container.getByLabel('Crop height (%)').fill('50');
  await container.getByLabel('Crop left (%)').fill('20');
  await container.getByLabel('Crop top (%)').fill('20');
}

test('crop matches processed proof, preserves original, and resets after rotation', async ({
  page,
}) => {
  const upload = await prepare(page);
  await chooseCrop(upload);
  await expect(upload.getByRole('button', { name: 'Scan & preview' })).toBeDisabled();
  await upload.getByRole('button', { name: 'Apply crop' }).click();
  await expect
    .poll(() =>
      upload
        .getByAltText('Report orientation preview')
        .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
    )
    .toEqual([100, 50]);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/upload') && r.request().method() === 'POST',
  );
  await upload.getByRole('button', { name: 'Scan & preview' }).click();
  const draft = await (await response).json();
  expect(draft.processing.crop).toEqual({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 });
  const proof = await page.request.get(`/api/proof?draft=${draft.token}&variant=processed`);
  expect(
    (
      await sharp(await proof.body())
        .removeAlpha()
        .raw()
        .toBuffer()
    ).equals(
      await sharp(image)
        .extract({ left: 40, top: 20, width: 100, height: 50 })
        .removeAlpha()
        .raw()
        .toBuffer(),
    ),
  ).toBe(true);
  expect(await (await page.request.get(`/api/proof?draft=${draft.token}`)).body()).toEqual(image);
  await upload.getByRole('button', { name: 'Discard preview' }).click();
  await upload.getByRole('button', { name: 'Edit crop' }).click();
  await upload.getByRole('button', { name: 'Cancel crop' }).click();
  await expect
    .poll(() =>
      upload
        .getByAltText('Report orientation preview')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(100);
  await upload.getByRole('button', { name: 'Rotate right' }).click();
  await expect(upload.getByRole('status', { name: 'Report crop' })).toContainText('reset');
  await expect
    .poll(() =>
      upload
        .getByAltText('Report orientation preview')
        .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
    )
    .toEqual([100, 200]);
});

test('crop can be resized and moved with keyboard or touch and survives viewport changes', async ({
  page,
}) => {
  const upload = await prepare(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await upload.getByRole('button', { name: 'Crop report', exact: true }).click();
  const corner = upload.getByRole('button', { name: 'Resize crop bottom right' });
  await corner.focus();
  await corner.press('Shift+ArrowLeft');
  await corner.press('Shift+ArrowUp');
  await expect(upload.getByLabel('Crop width (%)')).toHaveValue('95');
  const selection = upload.getByRole('group', { name: 'Crop selection' });
  await selection.focus();
  await selection.press('ArrowRight');
  await expect(upload.getByLabel('Crop left (%)')).toHaveValue('1');
  await upload.getByText('Precise crop adjustments', { exact: true }).click();
  await upload.getByLabel('Crop width (%)').fill('50');
  await upload.getByLabel('Crop height (%)').fill('50');
  await upload.getByLabel('Crop left (%)').fill('20');
  await upload.getByLabel('Crop top (%)').fill('20');
  await corner.scrollIntoViewIfNeeded();
  const box = (await corner.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const touch = { x: box.x + 22, y: box.y + 22 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...touch, x: touch.x + 20 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect
    .poll(async () => Number(await upload.getByLabel('Crop width (%)').inputValue()))
    .toBeGreaterThan(50);
  await upload.getByLabel('Crop width (%)').fill('50');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(upload.getByLabel('Crop left (%)')).toHaveValue('20');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await upload.getByRole('button', { name: 'Apply crop' }).click();
  await upload.getByRole('button', { name: 'Reset crop' }).click();
  await expect
    .poll(() =>
      upload
        .getByAltText('Report orientation preview')
        .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
    )
    .toEqual([200, 100]);
});

test('sample discovery receives the same crop and invalid crop submissions are rejected', async ({
  page,
}) => {
  await prepare(page);
  const editor = page.locator('.competition-editor');
  await editor.getByLabel('Competition name').fill('Crop sample');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByLabel('Sample report (optional)').setInputFiles(file);
  await expect(
    editor.getByRole('status', { name: 'Automatic orientation detection' }),
  ).toContainText('upright');
  await chooseCrop(editor);
  await editor.getByRole('button', { name: 'Apply crop' }).click();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/discover'));
  await editor.getByRole('button', { name: 'Suggest columns from sample' }).click();
  expect((await (await response).json()).processing).toMatchObject({
    width: 100,
    height: 50,
    crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
  });
  const invalid = await page.request.post('/api/discover', {
    headers: { Origin: 'http://127.0.0.1:4329' },
    multipart: {
      report: { name: file.name, mimeType: file.mimeType, buffer: image },
      crop: JSON.stringify({ x: 0.8, y: 0, width: 0.5, height: 1 }),
    },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error).toContain('crop');
});

test('fine rotation retains quarter turns and the processed crop matches the preview bounds', async ({
  page,
}) => {
  const upload = await prepare(page);
  const slider = upload.getByRole('slider', { name: 'Straighten image' });
  await slider.focus();
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('-0.1');
  await expect(upload.locator('.report-alignment-grid')).toBeVisible();
  await slider.fill('12.5');
  await upload.getByRole('button', { name: 'Rotate right' }).click();
  await expect(slider).toHaveValue('12.5');
  await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
    'Rotation: 102.5°',
  );
  await chooseCrop(upload);
  await expect(slider).toBeDisabled();
  await upload.getByRole('button', { name: 'Apply crop' }).click();
  const dimensions = await upload
    .getByAltText('Report orientation preview')
    .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/upload') && r.request().method() === 'POST',
  );
  await upload.getByRole('button', { name: 'Scan & preview' }).click();
  const draft = await (await response).json();
  expect(draft.processing.rotation).toBe(102.5);
  expect([draft.processing.width, draft.processing.height]).toEqual(dimensions);
  const opaque = await sharp(image).flatten({ background: '#fff' }).png().toBuffer();
  const expected = await sharp(opaque).rotate(102.5, { background: '#fff' }).png().toBuffer();
  const region = draft.processing.crop_pixels;
  const proof = await page.request.get(`/api/proof?draft=${draft.token}&variant=processed`);
  expect(
    await sharp(await proof.body())
      .removeAlpha()
      .raw()
      .toBuffer(),
  ).toEqual(await sharp(expected).extract(region).removeAlpha().raw().toBuffer());
  await upload.getByRole('button', { name: 'Discard preview' }).click();
  await upload.getByRole('button', { name: 'Reset straightening' }).click();
  await expect(slider).toHaveValue('0');
  await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
    'Rotation: 90°',
  );
});

test('straightening draws live frames and detects the boundary only after movement settles', async ({
  page,
}) => {
  const rotations: string[] = [];
  await page.route('**/api/page-boundary', (route) => {
    rotations.push(route.request().postData() || '');
    return route.fulfill({ json: { status: 'none', reason: 'already_framed', crop: null } });
  });
  const upload = await prepare(page);
  await expect(upload.getByRole('status', { name: 'Page boundary suggestion' })).toContainText(
    'already framed',
  );
  expect(rotations).toHaveLength(1);
  const slider = upload.getByRole('slider', { name: 'Straighten image' });
  await slider.focus();
  const encodedWhileMoving = await slider.evaluate(async (input: HTMLInputElement) => {
    const original = HTMLCanvasElement.prototype.toDataURL;
    let encoded = 0;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      ++encoded;
      return original.apply(this, args);
    };
    try {
      for (let angle = 1; angle <= 10; angle++) {
        input.value = String(angle);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return encoded;
    } finally {
      HTMLCanvasElement.prototype.toDataURL = original;
    }
  });
  expect(encodedWhileMoving).toBe(0);
  expect(rotations).toHaveLength(1);
  await expect(upload.getByLabel('Live report orientation preview')).toBeVisible();
  await expect.poll(() => rotations.length).toBe(2);
  expect(rotations[1]).toContain('10');
  await expect(upload.getByLabel('Live report orientation preview')).toBeHidden();
  await expect(upload.getByAltText('Report orientation preview')).toBeVisible();
  await slider.fill('15');
  await upload.getByRole('button', { name: 'Crop report', exact: true }).click();
  // Cropping cancels the pending detection and uses the latest angle immediately.
  await page.waitForTimeout(450);
  expect(rotations).toHaveLength(2);
  await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
    'Rotation: 15°',
  );
});
