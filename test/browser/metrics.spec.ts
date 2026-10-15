import { centralDate } from '../../src/lib/central-time.ts';
import sharp from 'sharp';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

test('results downloads reject missing, forged, tampered and expired admin sessions', async ({
  request,
}) => {
  const expired = String(Date.now() - 1000);
  const expiredSignature = createHmac('sha256', '6bfZQp8mJr5VvL9aT2cXH7nW')
    .update(expired)
    .digest('hex');
  const future = String(Date.now() + 3600000);
  for (const cookie of [
    '',
    'admin=true',
    `admin=${future}.forged`,
    `admin=${expired}.${expiredSignature}`,
    `admin=${future}.${expiredSignature}`,
  ]) {
    const response = await request.get(
      '/api/results?competition_id=1&metric=metric_2&period=lifetime',
      { headers: { Cookie: cookie } },
    );
    expect(response.status()).toBe(403);
    expect(await response.text()).toBe('Unauthorized.');
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(response.headers()['content-disposition']).toBeUndefined();
  }
});
const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#fff' } })
  .composite([
    {
      input: await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } })
        .png()
        .toBuffer(),
      left: 0,
      top: 0,
    },
  ])
  .png()
  .toBuffer();
test('schema discovery, edited preview, privacy, alternate sorting and acknowledged metric changes', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/login');
  await page.getByLabel('Admin passcode').fill('6bfZQp8mJr5VvL9aT2cXH7nW');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const editor = page.locator('.competition-editor');
  await editor.getByLabel('Competition name').fill('Multiple metrics');
  const yesterday = centralDate(Date.now() - 86400000),
    tomorrow = centralDate(Date.now() + 86400000);
  await editor.getByLabel('Start date', { exact: true }).fill(yesterday);
  await editor.getByLabel('End date', { exact: true }).fill(tomorrow);
  await editor.getByLabel('Make this the active competition').check();
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor
    .getByLabel('Sample report (optional)')
    .setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: image });
  await expect(editor.getByAltText('Report orientation preview')).toBeVisible();
  await editor.getByRole('button', { name: 'Rotate right' }).click();
  const discoveryResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/discover') && r.request().method() === 'POST',
  );
  await editor.getByRole('button', { name: 'Suggest columns from sample' }).click();
  expect((await (await discoveryResponse).json()).processing).toMatchObject({
    rotation: 90,
    width: 80,
    height: 120,
  });
  await expect(editor.getByLabel('Metric label', { exact: true })).toHaveCount(2);
  await expect(editor.getByLabel('Metric label', { exact: true }).nth(1)).toHaveValue(
    'Dollars Sold',
  );
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByLabel('Show on public leaderboards').nth(1).uncheck();
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByRole('button', { name: 'Create competition' }).click();
  await expect(page).toHaveURL(/competitions\/\d+/);
  const competitionPath = new URL(page.url()).pathname;
  const competitionId = competitionPath.split('/').pop();
  const visitor = await browser.newContext(),
    publicPage = await visitor.newPage();
  const showMainLeaderboard = async () => {
    // A Power Hour from the preceding browser test may still be displaying final results.
    const main = publicPage.getByRole('button', { name: 'View main leaderboard' });
    if (await main.isVisible()) await main.click();
  };
  const expandOverflow = async () => {
    const toggle = publicPage.locator('.overflow-toggle');
    if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false')
      await toggle.click();
  };
  try {
    await publicPage.goto('/');
    await showMainLeaderboard();
    await expect(publicPage.getByRole('link', { name: 'Download CSV' })).toHaveCount(0);
    expect(
      (await publicPage.request.get(`/api/results?competition_id=${competitionId}`)).status(),
    ).toBe(403);
    expect((await page.request.get('/api/results?competition_id=0')).status()).toBe(404);
    await expect(publicPage.locator('.compact-rankings .empty-state')).toBeVisible();
    expect(await publicPage.content()).not.toContain('Dollars Sold');
    await page.goto('/admin');
    const upload = page.locator('.report-upload[data-report-workflow=competition]');
    await upload
      .locator('input[type=file]')
      .setInputFiles({ name: 'report.png', mimeType: 'image/png', buffer: image });
    await expect(upload.getByRole('status', { name: 'Report image selection' })).toHaveText(
      'report.png selected. Ready to scan.',
    );
    await expect(upload.getByAltText('Report orientation preview')).toBeVisible();
    await upload.getByRole('button', { name: 'Rotate left' }).click();
    await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
      'Rotation: 270°',
    );
    // A camera-oriented JPEG previews upright; selecting another file resets manual rotation.
    const cameraImage = await sharp(image).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    await upload
      .locator('input[type=file]')
      .setInputFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: cameraImage });
    await expect(upload.getByRole('status', { name: 'Report image orientation' })).toHaveText(
      'Rotation: 0°',
    );
    await expect
      .poll(() =>
        upload
          .getByAltText('Report orientation preview')
          .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
      )
      .toEqual([80, 120]);
    await upload
      .locator('input[type=file]')
      .setInputFiles({ name: 'report.png', mimeType: 'image/png', buffer: image });
    await expect
      .poll(() =>
        upload
          .getByAltText('Report orientation preview')
          .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
      )
      .toEqual([120, 80]);
    await upload.getByRole('button', { name: 'Rotate right' }).click();
    const uploadResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/upload') && r.request().method() === 'POST',
    );
    await upload.getByRole('button', { name: 'Scan & preview' }).click();
    const draft = await (await uploadResponse).json();
    const original = await page.request.get(`/api/proof?draft=${draft.token}`);
    expect(await original.body()).toEqual(image);
    const processed = await page.request.get(`/api/proof?draft=${draft.token}&variant=processed`);
    expect(processed.headers()['content-type']).toBe('image/png');
    const actualPixels = await sharp(await processed.body())
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(actualPixels).toEqual(await sharp(image).rotate(90).removeAlpha().raw().toBuffer());
    expect(
      (await publicPage.request.get(`/api/proof?draft=${draft.token}&variant=processed`)).status(),
    ).toBe(403);
    await expect(upload.getByRole('heading', { name: 'Review extracted report' })).toBeVisible();
    await expect(upload.getByLabel('Dollars Sold row 1')).toHaveValue('125.00');
    await expect(upload.getByLabel('Number Sold total')).toHaveText('250');
    await expect(upload.getByLabel('Dollars Sold total')).toHaveText('$125.00');
    await upload.getByRole('button', { name: 'Add participant row', exact: true }).click();
    await expect(upload.locator('tfoot').getByText('Incomplete')).toHaveCount(2);
    await upload.getByLabel('Number Sold row 2').fill('0.10');
    await upload.getByLabel('Dollars Sold row 2').fill('-0.20');
    await expect(upload.getByLabel('Number Sold total')).toHaveText('250.1');
    await expect(upload.getByLabel('Dollars Sold total')).toHaveText('$124.80');
    await upload.getByRole('button', { name: 'Remove row 2', exact: true }).click();
    await expect(upload.getByLabel('Dollars Sold total')).toHaveText('$125.00');
    await publicPage.reload();
    await showMainLeaderboard();
    await expect(publicPage.locator('.compact-rankings .empty-state')).toBeVisible();
    await upload.getByLabel('Number Sold row 1').fill('50.25');
    await upload.getByLabel('Dollars Sold row 1').fill('24.63');
    await expect(upload.getByLabel('Dollars Sold total')).toHaveText('$24.63');
    await upload.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(upload.locator('.notice[role=status]')).toContainText('Draft saved');
    await upload.getByRole('button', { name: 'Close without saving' }).click();
    await page.reload();
    await upload.getByRole('button', { name: 'Resume Multiple metrics' }).click();
    await expect(upload.getByLabel('Number Sold row 1')).toHaveValue('50.25');
    await expect(upload.getByLabel('Dollars Sold row 1')).toHaveValue('24.63');
    await upload.getByText('Original extracted values', { exact: true }).click();
    await expect(upload.locator('.original-extraction tbody')).toContainText('250');
    const stale = await page.request.post('/api/drafts', {
      headers: { Origin: 'http://127.0.0.1:4329' },
      form: {
        payload: JSON.stringify({
          action: 'save',
          token: draft.token,
          revision: 1,
          report: draft.report,
        }),
      },
    });
    expect(stale.status()).toBe(400);
    expect((await stale.json()).error).toContain('another tab');
    await upload.getByLabel('I checked the dates and values against the source report.').check();
    await upload.getByRole('button', { name: 'Confirm & save report' }).click();
    await expect(upload.locator('.notice[role=status]')).toContainText('Report saved.');
    await publicPage.goto('/?metric=metric_2');
    await showMainLeaderboard();
    expect(await publicPage.content()).not.toContain('Dollars Sold');
    expect(await publicPage.content()).not.toContain('24.63');
    await expect(publicPage.getByLabel('Sort by metric')).toHaveValue('metric_1');
    await expect(publicPage.locator('.compact-table tbody')).toContainText('50.25');
    await page.goto(competitionPath);
    await expect(page.locator('.multi-metric-table tbody')).toContainText('$24.63');
    await page.getByLabel('Sort by metric').selectOption('metric_2');
    await expect(page).toHaveURL(/metric=metric_2/);
    const exportLink = page.getByRole('link', { name: 'Download CSV' });
    await expect(exportLink).toHaveAttribute(
      'href',
      `/api/results?competition_id=${competitionId}&metric=metric_2&period=lifetime`,
    );
    const downloadPromise = page.waitForEvent('download');
    await exportLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      `Multiple-metrics-${competitionId}-lifetime-metric_2-results.csv`,
    );
    const csv = await readFile((await download.path())!, 'utf8');
    expect(csv).toContain('"Dollars Sold (USD)"');
    expect(csv).toContain('24.63');
    await page.getByLabel('Time period').selectOption('week');
    await expect(exportLink).toHaveAttribute(
      'href',
      `/api/results?competition_id=${competitionId}&metric=metric_2&period=week`,
    );
    await expect(page.getByRole('button', { name: 'Apply view' })).toHaveCount(0);
    await expect(page.locator('.board-explanation')).toContainText(
      'Official competition ranking remains Number Sold',
    );
    await page.getByText('Edit metrics & report mapping', { exact: true }).click();
    const settings = page.locator('.competition-editor');
    await expect(settings.getByLabel('Value type').first()).toBeDisabled();
    await settings.getByRole('button', { name: 'Add metric', exact: true }).click();
    await settings.getByLabel('Metric label', { exact: true }).last().fill('Bonus');
    await settings.getByLabel('Require this value in future reports').last().uncheck();
    await settings.getByRole('button', { name: 'Continue', exact: true }).click();
    await settings.getByLabel('Show on public leaderboards').nth(1).check();
    await settings.getByLabel('Official ranking metric').selectOption('metric_2');
    await settings.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(
      settings.getByRole('button', { name: 'Save competition settings' }),
    ).toBeDisabled();
    await settings.getByRole('button', { name: 'Back', exact: true }).click();
    await settings.getByLabel('I understand and intend to change the official ranking.').check();
    await settings.getByRole('button', { name: 'Back', exact: true }).click();
    await settings
      .getByLabel('I intend to add these metrics and understand the missing history.')
      .check();
    await settings.getByRole('button', { name: 'Continue', exact: true }).click();
    await settings.getByRole('button', { name: 'Continue', exact: true }).click();
    await settings.getByRole('button', { name: 'Save competition settings' }).click();
    await expect(page.getByRole('status')).toContainText('Competition settings saved.');
    await publicPage.goto('/');
    await showMainLeaderboard();
    await expect(publicPage.getByLabel('Sort by metric')).toHaveValue('metric_2');
    await expect(publicPage.locator('.compact-table tbody')).toContainText('$24.63');
    await expect(publicPage.locator('.compact-table tbody td').nth(4)).toHaveText('—');
    // Populate enough participants to exercise chart capacity without altering real data.
    await page.goto('/admin');
    const configuration = JSON.parse(
      (await page.locator('.manual-report').getAttribute('x-data'))!.match(
        /^reportEntry\((\[.*\]),/,
      )![1],
    ).find((c: { id: number }) => competitionPath.endsWith(`/${c.id}`));
    const bonusKey = configuration.metrics.find(
      (metric: { label: string }) => metric.label === 'Bonus',
    ).key;
    const timestamp = new Date(Date.now() - 1000).toISOString(),
      day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Chicago' }).format(
        new Date(timestamp),
      );
    const saved = await page.request.post('/api/reports', {
      headers: { Origin: 'http://127.0.0.1:4329' },
      form: {
        payload: JSON.stringify({
          competition_id: configuration.id,
          schema_version: configuration.schema_version,
          confirmed: true,
          report: {
            generated_at: timestamp,
            period_start: day,
            period_end: day,
            rows: Array.from({ length: 12 }, (_, i) => ({
              participant_id: String(500 + i),
              values: {
                metric_1: String(100 + i),
                metric_2: String(200 - i),
                [bonusKey]: i === 0 ? '5' : null,
              },
            })),
          },
        }),
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    await publicPage.reload();
    await showMainLeaderboard();
    const visibleBars = publicPage.locator('.compact-column:visible');
    let mobileCount = 0;
    for (const width of [320, 700, 1280]) {
      await publicPage.setViewportSize({ width, height: 844 });
      await expect.poll(() => visibleBars.count()).toBeGreaterThan(0);
      await expect
        .poll(() => publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await expect
        .poll(async () => {
          await expandOverflow();
          const bars = await visibleBars.locator('.compact-operator').allTextContents();
          const table = await publicPage
            .locator('.compact-table tbody tr:visible td:nth-child(2) strong')
            .allTextContents();
          return {
            total: bars.length + table.length,
            duplicates: table.filter((id) => bars.includes(id)),
            continuesAfterBars:
              table[0] ===
              (await publicPage
                .locator('.compact-column .compact-operator')
                .nth(bars.length)
                .textContent()),
          };
        })
        .toEqual({ total: 13, duplicates: [], continuesAfterBars: true });
      if (width === 320) mobileCount = await visibleBars.count();
      if (width === 1280) await expect.poll(() => visibleBars.count()).toBeGreaterThan(mobileCount);
    }
    await expect(visibleBars.first().locator('.compact-operator')).toHaveText('#500');
    const bar = await visibleBars.first().locator('.compact-bar').boundingBox();
    expect(bar!.height).toBeGreaterThan(bar!.width);
    await publicPage
      .locator('.compact-controls')
      .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const scrollPosition = await publicPage.evaluate(() => {
      (window as any).__boardDocument = 'same-document';
      return scrollY;
    });
    await publicPage.getByLabel('Sort by metric').selectOption('metric_1');
    await expect(publicPage).toHaveURL(/metric=metric_1/);
    await expect(visibleBars.first().locator('.compact-operator')).toHaveText('#511');
    await publicPage.getByLabel('Time period').selectOption('day');
    await expect(publicPage).toHaveURL(/period=day/);
    await expect(visibleBars.first().locator('.compact-operator')).toHaveText('#511');
    expect(await publicPage.evaluate(() => (window as any).__boardDocument)).toBe('same-document');
    await expect.poll(() => publicPage.evaluate(() => scrollY)).toBeCloseTo(scrollPosition, 0);
    await publicPage.getByRole('link', { name: 'Refresh standings' }).click();
    await expect(publicPage.locator('[data-competition-board]')).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(await publicPage.evaluate(() => (window as any).__boardDocument)).toBe('same-document');
    // A slower first selection must not replace the most recent view.
    let completeDelayedView!: () => void;
    const delayedViewFinished = new Promise<void>((resolve) => (completeDelayedView = resolve));
    await publicPage.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const delayed = url.pathname === '/' && url.searchParams.get('metric') === 'metric_2';
      if (delayed) await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
      if (delayed) completeDelayedView();
    });
    await publicPage.getByLabel('Sort by metric').selectOption('metric_2');
    await publicPage.getByLabel('Sort by metric').selectOption('metric_1');
    await expect(publicPage.locator('[data-competition-board]')).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(visibleBars.first().locator('.compact-operator')).toHaveText('#511');
    await expect(publicPage).toHaveURL(/metric=metric_1/);
    await delayedViewFinished;
    await publicPage.unroute('**/*');
    await publicPage.route('**/*', async (route) => {
      if (new URL(route.request().url()).pathname === '/')
        await route.fulfill({ status: 503, body: 'Unavailable' });
      else await route.continue();
    });
    await publicPage.getByRole('link', { name: 'Refresh standings' }).click();
    await expect(publicPage.locator('.board-error')).toContainText('Unable to update standings');
    await expect(visibleBars.first().locator('.compact-operator')).toHaveText('#511');
    await publicPage.unroute('**/*');
    await publicPage.getByLabel('Sort by metric').selectOption(bonusKey);
    await expect(visibleBars.locator('.compact-operator')).toHaveText(['#500']);
    await expect(publicPage.locator('.overflow-toggle')).toBeVisible();
    await expandOverflow();
    await expect(publicPage.locator('.compact-table tbody tr:visible')).toHaveCount(12);
    await expect(publicPage.locator('.compact-table tbody tr:visible .rank')).toHaveText(
      Array(12).fill('—'),
    );
    expect(errors).toEqual([]);
  } finally {
    await visitor.close();
  }
});
