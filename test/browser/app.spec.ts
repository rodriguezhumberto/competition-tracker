import { centralDate } from '../../src/lib/central-time.ts';
import sharp from 'sharp';
import { test, expect } from '@playwright/test';
const yesterday = centralDate(Date.now() - 86400000);
const tomorrow = centralDate(Date.now() + 86400000);
test('admin setup, SSR, OCR validation, Power Hour takeover and mobile layout', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page
      .locator('.top-operators .empty-state:visible')
      .filter({ hasText: 'No progress reports in this period yet.' }),
  ).toBeVisible();
  await page.goto('/admin');
  await expect(page).toHaveURL(/admin\/login/);
  await page.getByLabel('Admin passcode').fill('6bfZQp8mJr5VvL9aT2cXH7nW');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  for (const width of [320, 700]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => {
      const panels = [...document.querySelectorAll<HTMLElement>('.admin-grid > .panel')];
      const grid = document.querySelector<HTMLElement>('.admin-grid')!;
      const powerHour = document.querySelector<HTMLElement>('.power-hour-admin')!;
      const powerHourForm = powerHour.querySelector<HTMLElement>('form')!;
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        stacked: panels.every(
          (panel) =>
            Math.abs(panel.getBoundingClientRect().width - grid.getBoundingClientRect().width) < 1,
        ),
        controlsFit: panels.every((panel) =>
          [
            ...panel.querySelectorAll<HTMLElement>(
              'input:not([type=hidden]),select,textarea,button',
            ),
          ]
            .filter((control) => control.checkVisibility())
            .every((control) => {
              const field = control.getBoundingClientRect(),
                bounds = panel.getBoundingClientRect();
              return field.left >= bounds.left && field.right <= bounds.right;
            }),
        ),
        dateFieldsReadable: [
          ...grid.querySelectorAll<HTMLInputElement>('input[type=date],input[type=datetime-local]'),
        ].every((input) => parseFloat(getComputedStyle(input).fontSize) >= 16),
        dateFieldsContained: [
          ...grid.querySelectorAll<HTMLInputElement>('input[type=date],input[type=datetime-local]'),
        ].every((input) => {
          const wrapper = input.parentElement!,
            panel = input.closest('.panel')!;
          return (
            wrapper.getBoundingClientRect().right <= panel.getBoundingClientRect().right &&
            getComputedStyle(wrapper).overflow === 'hidden' &&
            getComputedStyle(input).paddingLeft === '0px' &&
            getComputedStyle(input).paddingRight === '0px'
          );
        }),
        powerHourFormFits:
          powerHourForm.getBoundingClientRect().right <=
          powerHour.getBoundingClientRect().right - 20,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.stacked).toBe(true);
    expect(layout.controlsFit).toBe(true);
    expect(layout.dateFieldsContained).toBe(true);
    if (width === 320) expect(layout.dateFieldsReadable).toBe(true);
    expect(layout.powerHourFormFits).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole('button', { name: 'Start Power Hour' })).toBeEnabled();
  const competition = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'New competition', exact: true }) });
  await competition.getByLabel('Competition name').fill('The monthly climb');
  await competition.getByLabel('Start date').fill(yesterday);
  await competition.getByLabel('End date').fill(tomorrow);
  await competition.getByRole('button', { name: 'Continue', exact: true }).click();
  await competition.getByLabel('Metric label', { exact: true }).fill('Points');
  await competition.getByRole('button', { name: 'Continue', exact: true }).click();
  await competition.getByRole('button', { name: 'Continue', exact: true }).click();
  await competition.getByRole('button', { name: 'Create competition' }).click();
  await expect(page).toHaveURL(/competitions\/\d+/);
  await page.goto('/admin');
  const manual = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Add a batch report manually' }) });
  await manual.getByLabel('Report generation time').fill(`${yesterday}T10:00`);
  await manual.getByLabel('Period start').fill(yesterday);
  await manual.getByLabel('Period end').fill(yesterday);
  await manual.getByLabel('Operator number row 1').fill('119');
  await manual.getByLabel('Points row 1').fill('100.5');
  await manual.getByRole('button', { name: 'Save batch report' }).click();
  await expect(manual.getByRole('status')).toContainText('Report saved.');
  await page.reload();
  await expect(
    page.locator('section').filter({ has: page.getByRole('heading', { name: 'Recent reports' }) }),
  ).toContainText(/10:00:00 C[DS]T/);
  const upload = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Scan a batch progress report' }) });
  const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const submitImage = async () => {
    await upload
      .locator('input[type=file]')
      .setInputFiles({ name: 'report.png', mimeType: 'image/png', buffer: image });
    await upload.getByRole('button', { name: 'Scan & preview' }).click();
  };
  await submitImage();
  await expect(upload.getByRole('heading', { name: 'Review extracted report' })).toBeVisible();
  await expect(upload.getByRole('button', { name: 'Confirm & save report' })).toBeDisabled();
  await upload.getByLabel('I checked the dates and values against the source report.').check();
  await upload.getByRole('button', { name: 'Confirm & save report' }).click();
  await expect(upload.locator('.notice[role=status]')).toHaveText(
    'Report saved. Updated 1 participant.',
  );
  await expect(upload.locator('input[type=file]')).toHaveValue('');
  await expect(upload.getByAltText('Report orientation preview')).not.toBeVisible();
  await submitImage();
  await upload.getByLabel('I checked the dates and values against the source report.').check();
  await upload.getByRole('button', { name: 'Confirm & save report' }).click();
  await expect(upload.getByRole('alert')).toContainText('newer than the last entry');
  expect(
    await upload
      .locator('input[type=file]')
      .evaluate((input: HTMLInputElement) => input.files?.length),
  ).toBe(1);
  await expect(upload.locator('.report-preview')).toBeVisible();
  await page.goto('/competitions');
  await page.getByRole('link', { name: 'View The monthly climb standings' }).click();
  await expect(page.getByRole('heading', { name: 'The monthly climb.' })).toBeVisible();
  await expect(page.locator('.vertical-column:visible .vertical-sales')).toContainText('350.5');
  await expect(page.locator('.multi-metric-table')).toBeHidden();
  await page.getByRole('link', { name: 'Refresh standings' }).click();
  await expect(page.getByRole('heading', { name: 'The monthly climb.' })).toBeVisible();
  await page.getByRole('link', { name: 'All competitions' }).click();
  await expect(page.getByRole('link', { name: 'View The monthly climb standings' })).toBeVisible();
  await page.goto('/admin');
  await page.reload();
  await page.getByRole('link', { name: 'View', exact: true }).click({ modifiers: [] });
  // Proof opens in a separate tab; the protected admin page stays in place.
  const viewer = await browser.newContext();
  const board = await viewer.newPage();
  await board.goto('/competitions/1');
  await expect(board).toHaveURL(/admin\/login/);
  const missing = await page.request.get('/competitions/999999');
  expect(missing.status()).toBe(404);
  await board.goto('/');
  await expect(
    board.locator('.compact-rankings .compact-column:visible .compact-bar-label strong'),
  ).toContainText('350.5');
  const unauthorized = await viewer.request.post('/api/admin', {
    form: { action: 'start', name: 'Forbidden' },
  });
  expect(unauthorized.status()).toBe(403);
  await page.getByLabel('Duration (minutes)').fill('25');
  await page.getByLabel('Shared password').fill('browser shared password');
  const powerHourName = await page.getByLabel('Power Hour name').inputValue();
  await page.getByRole('button', { name: 'Start Power Hour' }).click();
  const liveLeaderboard = page.getByRole('region', { name: 'Live Power Hour leaderboard' });
  await expect(liveLeaderboard).toContainText('Waiting for participants to join.');
  await expect(liveLeaderboard.locator('.power-hour-review-count')).toHaveText('No flags');
  await expect(board.locator('.takeover-bar')).toContainText('POWER HOUR LOBBY • CONNECTED');
  await expect(board.locator('.power-hour-live > .eyebrow')).toHaveCount(0);
  await expect(board.locator('.timer')).toHaveText(/24:\d\d/);
  await page.getByLabel('Add minutes').fill('15');
  await page.getByRole('button', { name: 'Add time' }).click();
  await expect(board.locator('.timer')).toHaveText(/39:\d\d/);
  await board.getByLabel('Shared password').fill('browser shared password');
  await board.getByLabel('Your name').fill('Alex Morgan');
  await board.getByRole('button', { name: 'Join the Power Hour' }).click();
  await expect(board.locator('.tap-button')).toBeVisible();
  const cookie = (await viewer.cookies()).find((item) => item.name === 'power_hour_participant');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.expires).toBe(-1);
  const otherBrowser = await browser.newContext();
  const otherBoard = await otherBrowser.newPage();
  await otherBoard.goto('/');
  await expect(otherBoard.locator('.takeover-bar')).toContainText('POWER HOUR LOBBY • CONNECTED');
  await otherBoard.getByLabel('Shared password').fill('browser shared password');
  await otherBoard.getByLabel('Your name').fill('Alex Morgan');
  await otherBoard.getByRole('button', { name: 'Join the Power Hour' }).click();
  await expect(otherBoard.getByRole('alert')).toContainText('already in use');
  await expect(otherBoard.locator('.tap-button')).not.toBeVisible();
  await otherBrowser.close();
  await board.locator('.tap-button').click();
  await board.locator('.tap-button').click();
  await board.locator('.tap-button').click();
  await expect(board.locator('.my-score')).toHaveText('3');
  await expect(liveLeaderboard.locator('tbody tr')).toHaveCount(1);
  await expect(liveLeaderboard.locator('tbody')).toContainText('Alex Morgan');
  await expect(liveLeaderboard.locator('tbody .score-col strong')).toHaveText('3');
  for (let i = 0; i < 8; i++) await board.locator('.tap-button').click();
  await expect(liveLeaderboard.locator('.power-hour-flag')).toBeVisible();
  await expect(liveLeaderboard.locator('.power-hour-review-count')).toHaveText(
    '1 flagged for review',
  );
  await expect(liveLeaderboard.locator('.power-hour-review-notice')).toBeVisible();
  await expect(liveLeaderboard.locator('tbody .score-col strong')).toHaveText('11');
  await board.getByRole('button', { name: 'View main leaderboard' }).click();
  await expect(board.locator('.takeover-bar')).toContainText('POWER HOUR IS LIVE');
  await expect(
    board.locator('.compact-rankings .compact-column:visible .compact-bar-label strong'),
  ).toContainText('350.5');
  await board.getByRole('button', { name: 'Back to Power Hour' }).click();
  await expect(board.locator('.takeover-bar')).toContainText('POWER HOUR LOBBY • CONNECTED');
  await expect(board.locator('.my-score')).toHaveText('11');
  const reconnect = await viewer.newPage();
  await reconnect.goto('/');
  await expect(reconnect.locator('.tap-button')).toBeVisible();
  await expect(reconnect.locator('.my-score')).toHaveText('11');
  await page.getByRole('button', { name: 'End & archive' }).click();
  await expect(board.getByRole('heading', { name: 'Final standings' })).toBeVisible();
  await expect(board.locator('.tap-button')).toBeDisabled();
  await expect(board.locator('.my-score')).toHaveText('11');
  await board.reload();
  await expect(board.getByRole('heading', { name: 'Final standings' })).toBeVisible();
  await expect(board.locator('.my-score')).toHaveText('11');
  await board.goto('/archive');
  await expect(board.getByRole('heading', { name: powerHourName })).toBeVisible();
  await expect(board.locator('.archive-card li strong')).toHaveText('11 points');
  await board.getByRole('link', { name: `View ${powerHourName} full results` }).click();
  await expect(board).toHaveURL(/\/archive\/\d+$/);
  await expect(board.locator('.leaderboard-table tbody tr')).toHaveCount(1);
  await expect(board.locator('.leaderboard-table tbody')).toContainText('Alex Morgan');
  await expect(board.locator('.leaderboard-table tbody .score-col strong')).toHaveText('11');
  await board.getByRole('link', { name: 'Power Hour archive' }).last().click();
  await expect(board.locator('.archive-card')).toHaveCount(1);
  const missingArchive = await board.request.get('/archive/999999');
  expect(missingArchive.status()).toBe(404);
  await board.goto('/');
  await board.setViewportSize({ width: 390, height: 844 });
  expect(
    await board.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await board.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await board.setViewportSize({ width: 1440, height: 1000 });
  await board.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  expect(errors).toEqual([]);
  await viewer.close();
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJs.newPage();
  await staticPage.goto('/');
  await expect(
    staticPage
      .locator('.compact-rankings .compact-column')
      .last()
      .locator('.compact-bar-label strong'),
  ).toContainText('350.5');
  await noJs.close();
});

test('live bar standings, shared scaling, reconnects and sticky mobile controls', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  await page.goto('/admin');
  await page.getByLabel('Admin passcode').fill('6bfZQp8mJr5VvL9aT2cXH7nW');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Power Hour name').fill('Mobile bar Power Hour');
  await page.getByLabel('What are you tracking?').fill('calls');
  await page.getByLabel('Shared password').fill('mobile bar password');
  await page.getByRole('button', { name: 'Start Power Hour' }).click();
  const contexts = [];
  try {
    const alexContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(alexContext);
    const alex = await alexContext.newPage();
    alex.on('pageerror', (error) => errors.push(error.message));
    await alex.goto('/');
    await alex.getByLabel('Shared password').fill('mobile bar password');
    await alex.getByLabel('Your name').fill('Alex');
    await alex.getByRole('button', { name: 'Join the Power Hour' }).click();
    await expect(alex.locator('.tap-button')).toBeEnabled();
    await expect(alex.locator('.lobby-count')).toHaveText('0');
    await expect(alex.locator('.lobby-bar-fill')).toHaveAttribute('style', 'transform: scaleX(0)');
    const jordanContext = await browser.newContext();
    contexts.push(jordanContext);
    const jordan = await jordanContext.newPage();
    jordan.on('pageerror', (error) => errors.push(error.message));
    await jordan.goto('/');
    await jordan.getByLabel('Shared password').fill('mobile bar password');
    await jordan.getByLabel('Your name').fill('Jordan');
    await jordan.getByRole('button', { name: 'Join the Power Hour' }).click();
    await expect(jordan.locator('.tap-button')).toBeEnabled();
    // Joining alone updates all existing participants, before anyone taps.
    await expect(alex.locator('.lobby-rank-row')).toHaveCount(2);
    await jordan.locator('.tap-button').click();
    await expect(alex.locator('.lobby-name').first()).toHaveText('Jordan');
    await expect(alex.locator('.lobby-bar-fill').first()).toHaveAttribute(
      'style',
      'transform: scaleX(0.1)',
    );
    await alex.locator('.tap-button').click();
    await expect(jordan.locator('.lobby-name').first()).toHaveText('Alex');
    for (let i = 0; i < 9; i++) await alex.locator('.tap-button').click();
    await expect(alex.locator('.my-score')).toHaveText('10');
    await expect(alex.locator('.lobby-board-meta')).toContainText('Scale: 0–20 calls');
    await expect(alex.locator('.lobby-bar-fill').first()).toHaveAttribute(
      'style',
      'transform: scaleX(0.5)',
    );
    await expect(jordan.locator('.lobby-bar-fill').first()).toHaveAttribute(
      'style',
      'transform: scaleX(0.5)',
    );
    // Disconnect an established socket and verify the last board remains available.
    await alex.evaluate(() => {
      const root = document.querySelector('[x-data]')!;
      (root as any)._x_dataStack[0].socket.close();
    });
    await expect(alex.locator('.tap-button')).toBeDisabled();
    await expect(alex.locator('.lobby-rank-row')).toHaveCount(2);
    await expect(alex.locator('.my-score')).toHaveText('10');
    await expect(alex.locator('.power-hour-join')).not.toBeVisible();
    await expect(alex.locator('.tap-button')).toBeEnabled({ timeout: 10000 });
    await expect(alex.locator('.my-score')).toHaveText('10');
    const sessionId = await alex.evaluate(
      () => (document.querySelector('[x-data]') as any)._x_dataStack[0].session.id,
    );
    for (let i = 0; i < 18; i++) {
      const context = await browser.newContext();
      contexts.push(context);
      const response = await context.request.post('/api/power-hour/join', {
        headers: { Origin: 'http://127.0.0.1:4329' },
        form: {
          sessionId: String(sessionId),
          name: `Participant ${i + 1}`,
          password: 'mobile bar password',
        },
      });
      expect(response.ok()).toBe(true);
    }
    await expect(alex.locator('.lobby-rank-row')).toHaveCount(20);
    for (const width of [320, 390, 700]) {
      await alex.setViewportSize({ width, height: 844 });
      await alex.evaluate(() => window.scrollTo(0, 0));
      await expect(alex.locator('.tap-button')).toBeInViewport();
      const layout = await alex.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= innerWidth,
        pageScroll:
          document.querySelector('.live-ranks')!.scrollHeight ===
          document.querySelector('.live-ranks')!.clientHeight,
        sticky:
          getComputedStyle(document.querySelector('.power-hour-controls')!).position === 'sticky',
      }));
      expect(layout).toEqual({ fits: true, pageScroll: true, sticky: true });
      await alex.locator('.lobby-rank-row').last().scrollIntoViewIfNeeded();
      await expect(alex.locator('.tap-button')).toBeInViewport();
      const clear = await alex.evaluate(
        () =>
          document.querySelector('.lobby-rank-row:last-child')!.getBoundingClientRect().bottom <=
          document.querySelector('.power-hour-controls')!.getBoundingClientRect().top,
      );
      expect(clear).toBe(true);
    }
    await alex.setViewportSize({ width: 390, height: 844 });
    await alex.evaluate(() => window.scrollTo(0, 0));
    await alex.screenshot({ path: 'test-results/power-hour-mobile-light.png', fullPage: true });
    await alex.getByRole('button', { name: 'Switch to dark mode' }).click();
    await alex.screenshot({ path: 'test-results/power-hour-mobile-dark.png', fullPage: true });
    await alex.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await alex
        .locator('.lobby-bar-fill')
        .first()
        .evaluate((element) => getComputedStyle(element).transitionDuration),
    ).toBe('0s');
    await alex.setViewportSize({ width: 1440, height: 1000 });
    await alex.screenshot({ path: 'test-results/power-hour-desktop.png', fullPage: true });
    await alex.getByRole('button', { name: 'View main leaderboard' }).click();
    await expect(alex.locator('.power-hour-controls')).not.toBeVisible();
    await alex.getByRole('button', { name: 'Back to Power Hour' }).click();
    await expect(alex.locator('.tap-button')).toBeEnabled();
    await page.getByRole('button', { name: 'End & archive' }).click();
    await expect(alex.getByRole('heading', { name: 'Final standings' })).toBeVisible();
    await expect(alex.locator('.tap-button')).toBeDisabled();
    for (const width of [320, 390, 700]) {
      await alex.setViewportSize({ width, height: 844 });
      await alex.reload();
      await expect(alex.getByRole('heading', { name: 'Final standings' })).toBeVisible();
      await expect(alex.locator('.lobby-rank-row')).toHaveCount(20);
      await expect(alex.locator('.my-score')).toHaveText('10');
      await expect(alex.locator('.tap-button')).toBeDisabled();
      await expect
        .poll(() => alex.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await alex.locator('.lobby-rank-row').first().scrollIntoViewIfNeeded();
      await expect(alex.locator('.lobby-rank-row').first()).toBeInViewport();
    }
    await page.getByLabel('Shared password').fill('mobile bar password');
    await page.getByRole('button', { name: 'Start Power Hour' }).click();
    await expect(alex.locator('.power-hour-join')).toBeVisible();
    await expect(alex.locator('.power-hour-controls')).not.toBeVisible();
    await page.getByRole('button', { name: 'End & archive' }).click();
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
  }
});
