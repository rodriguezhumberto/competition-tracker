import { test, expect } from '@playwright/test';

test('demo uses the product board, Power Hour takeover, and archive pages', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('link', { name: 'Competition Tracker home' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Leaderboard', exact: true })).toBeVisible();
  await expect(page.locator('[data-competition-board]')).toBeVisible();
  await expect(page.locator('.compact-column')).toHaveCount(8);
  await expect(page.locator('.demo-intro')).toHaveCount(0);
  await page.getByLabel('Sort by metric').selectOption('sales');
  await expect(page).toHaveURL(/metric=sales/);
  await expect(page.locator('.compact-bar-label:visible').first()).toContainText('$');
  await page.getByRole('link', { name: 'View report activity' }).click();
  await expect(page).toHaveURL(/\/demo\/activity\?metric=sales/);
  await expect(page.getByRole('heading', { name: 'Report activity' })).toBeVisible();
  await page.getByRole('link', { name: 'Older reports' }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('link', { name: 'Back to leaderboard' }).click();
  await page.getByRole('button', { name: 'Start demo Power Hour' }).click();
  await expect(page.locator('.takeover-bar')).toBeVisible();
  await expect(page.locator('.power-hour-live')).toBeVisible();
  await expect(page.locator('[data-competition-board]')).toBeHidden();
  await page.getByLabel('Your name').fill('Product Visitor');
  await page.getByRole('button', { name: 'Join the Power Hour' }).click();
  await expect(page.locator('.live-grid')).toBeVisible();
  await page.locator('.tap-button').click();
  await expect(page.locator('.my-score')).toHaveText('1');
  await page.getByRole('button', { name: 'View main leaderboard' }).click();
  await expect(page.locator('[data-competition-board]')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Power Hour' }).click();
  await expect(page.locator('.live-ranks')).toBeVisible();
  await page.getByText('Demo controls', { exact: true }).click();
  await page.getByRole('button', { name: 'End & archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Final standings' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Power Hour archive' })
    .click();
  await page.getByRole('link', { name: 'View Demo Power Hour full results' }).click();
  await expect(page.locator('.leaderboard-table')).toContainText('Product Visitor');
});

test('public demo is isolated, supports real participation, and resets sample data', async ({
  page,
  browser,
}) => {
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: /Team Sales Challenge/ })).toBeVisible();
  const snapshot = async () => page.evaluate(async () => (await fetch('/api/demo')).json());
  const action = async (input: Record<string, unknown>) =>
    page.evaluate(async (body) => {
      const response = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }, input);
  const initial = await snapshot();
  expect(initial.board.rows).toHaveLength(8);
  expect(initial.archives).toHaveLength(1);
  const incompleteInvite = await page.evaluate(
    async (room) => (await fetch(`/api/demo?room=${room}`)).status,
    initial.workspaceId,
  );
  expect(incompleteInvite).toBe(403);
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto('/demo');
  await expect(other.getByRole('heading', { name: /Team Sales Challenge/ })).toBeVisible();
  const otherInitial = await other.evaluate(async () => (await fetch('/api/demo')).json());
  expect(otherInitial.workspaceId).not.toBe(initial.workspaceId);
  const started = await action({ action: 'start' });
  expect(started.status).toBe(200);
  const presenter = await action({ action: 'mode', mode: 'presenter' });
  expect(presenter.data.workspaceId).toBe(initial.workspaceId);
  expect(presenter.data.session.id).toBe(started.data.session.id);
  const paused = await action({ action: 'pause' });
  expect(paused.data.simulation.paused).toBe(true);
  const publicMode = await action({ action: 'mode', mode: 'public' });
  expect(publicMode.data.simulation.paused).toBe(false);
  const filtered = await page.evaluate(async () =>
    (await fetch('/api/demo?metric=sales&period=day')).json(),
  );
  expect(filtered.board.rows).toHaveLength(8);
  expect(filtered.board.selected.key).toBe('sales');
  const sessionId = started.data.session.id;
  const joined = await action({ action: 'join', sessionId, name: 'Demo Visitor' });
  expect(joined.data.participant.name).toBe('Demo Visitor');
  const scored = await action({ action: 'increment', sessionId });
  expect(scored.data.scores.find((p: { name: string }) => p.name === 'Demo Visitor').clicks).toBe(
    1,
  );
  await page.reload();
  expect((await snapshot()).participant.name).toBe('Demo Visitor');
  expect((await other.evaluate(async () => (await fetch('/api/demo')).json())).session).toBeNull();
  const ended = await action({ action: 'end' });
  expect(ended.data.session.status).toBe('ended');
  expect(ended.data.archives).toHaveLength(2);
  expect((await action({ action: 'increment', sessionId })).status).toBe(400);
  const reset = await action({ action: 'reset' });
  expect(reset.data.workspaceId).toBe(initial.workspaceId);
  expect(reset.data.session).toBeNull();
  expect(reset.data.archives).toHaveLength(1);
  expect(reset.data.board.rows).toHaveLength(8);
  await second.close();
});

test('presenter invite lets audience participate without host privileges', async ({
  page,
  browser,
}) => {
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: /Team Sales Challenge/ })).toBeVisible();
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', mode: 'presenter' }),
    });
    return response.json();
  });
  await page.reload();
  const qr = page.getByRole('img', { name: 'QR code for the audience join link' });
  await expect(qr).toBeVisible();
  expect(
    await qr.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);
  const invite = await page.getByLabel('Audience join link', { exact: true }).inputValue();
  await expect(page.getByRole('link', { name: 'Open audience join link' })).toHaveAttribute(
    'href',
    invite,
  );
  expect(new URL(invite).searchParams.get('room')).toBe(created.workspaceId);
  expect(new URL(invite).searchParams.get('invite')).toBe(created.shareToken);
  await page.evaluate(async () =>
    fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }),
  );
  const context = await browser.newContext();
  const audience = await context.newPage();
  await audience.goto(invite);
  await expect(
    audience.getByRole('img', { name: 'QR code for the audience join link' }),
  ).toHaveCount(0);
  await expect(audience.getByRole('button', { name: 'Join the Power Hour' })).toBeVisible();
  const audienceState = await audience.evaluate(
    async ({ room, invite }) => (await fetch(`/api/demo?room=${room}&invite=${invite}`)).json(),
    { room: created.workspaceId, invite: created.shareToken },
  );
  expect(audienceState.role).toBe('audience');
  expect(audienceState.shareToken).toBeUndefined();
  const denied = await audience.evaluate(
    async ({ room, invite }) => {
      const response = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', room, invite }),
      });
      return response.status;
    },
    { room: created.workspaceId, invite: created.shareToken },
  );
  expect(denied).toBe(400);
  const adminDenied = await audience.request.get(
    `/demo/admin?room=${created.workspaceId}&invite=${created.shareToken}`,
  );
  expect(adminDenied.status()).toBe(403);
  await audience.getByLabel('Your name').fill('Audience Member');
  await audience.getByRole('button', { name: 'Join the Power Hour' }).click();
  await audience.getByRole('button', { name: /Add point/ }).click();
  await expect(audience.locator('.my-score')).toHaveText('1');
  await context.close();
});

test('real admin launches a fresh presenter demo with its QR code visible', async ({ page }) => {
  const launchUrl = '/api/demo/launch';
  const unauthorized = await page.request.post(launchUrl, {
    headers: { Origin: 'http://127.0.0.1:4329' },
  });
  expect(unauthorized.status()).toBe(403);
  await page.goto('/admin');
  await page.getByLabel('Admin passcode').fill('6bfZQp8mJr5VvL9aT2cXH7nW');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const competitions = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Your competitions', exact: true }),
  });
  const liveCompetitions = await competitions.innerText();
  const denied = await page.request.post(launchUrl, {
    headers: { Origin: 'https://untrusted.example' },
  });
  expect(denied.status()).toBe(403);
  await page.getByRole('button', { name: 'Launch demo' }).click();
  await expect(page).toHaveURL(/\/demo\/admin$/);
  await expect(page.getByRole('img', { name: 'QR code for the audience join link' })).toBeVisible();
  const state = await page.evaluate(async () => (await fetch('/api/demo')).json());
  expect(state.mode).toBe('presenter');
  expect(state.role).toBe('owner');
  await expect(page.getByRole('heading', { name: 'New competition' })).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByRole('button', { name: 'Launch demo' })).toBeVisible();
  expect(await competitions.innerText()).toBe(liveCompetitions);
});

test('demo admin uses product controls and preserves archived review flags', async ({ page }) => {
  await page.goto('/demo/admin');
  await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Start Power Hour/ }).click();
  const live = page.getByRole('region', { name: 'Live Power Hour leaderboard' });
  await expect(live).toBeVisible();
  await page.getByText('Demo controls', { exact: true }).click();
  await page.getByRole('button', { name: 'Show review flag' }).click();
  await expect(live.locator('.power-hour-review-count')).toHaveText('1 flagged for review');
  const admin = page.locator('.power-hour-admin');
  await admin.getByLabel('Add minutes').fill('1');
  await admin.getByRole('button', { name: 'Add time', exact: true }).click();
  await expect(live).toBeVisible();
  await admin.getByRole('button', { name: 'End & archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start a Power Hour' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Power Hour archive' })
    .click();
  await page.getByRole('link', { name: 'View Demo Power Hour full results' }).click();
  await expect(page.locator('.leaderboard-table')).toContainText('review entry rate');
});
