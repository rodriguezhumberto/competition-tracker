import { test, expect } from '@playwright/test';

test('competition demo uses the real wizard, activation, settings, and isolated data', async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname);
  });
  await page.goto('/demo/admin');
  const original = await page.evaluate(async () => (await fetch('/api/demo')).json());
  const editor = page.locator('.competition-editor');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Enter a competition name');
  await editor.getByLabel('Competition name').fill('Demo Service Challenge');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Suggest columns from sample' })).toHaveCount(0);
  await editor.getByLabel('Metric label', { exact: true }).fill('Orders');
  await editor.getByLabel('Value type').selectOption('integer');
  await editor.getByLabel('Scoring mode').selectOption('additive');
  await editor.getByRole('button', { name: 'Add metric', exact: true }).click();
  await editor.getByLabel('Metric label', { exact: true }).nth(1).fill('Revenue');
  await editor.getByLabel('Value type').nth(1).selectOption('currency');
  await editor.getByLabel('Scoring mode').nth(1).selectOption('additive');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByLabel('Show on public leaderboards').nth(1).uncheck();
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(editor.getByRole('heading', { name: 'Demo Service Challenge' })).toBeVisible();
  await editor.getByRole('button', { name: 'Create competition', exact: true }).click();
  await expect(page).toHaveURL(/\/demo\/competitions\/\d+\?saved=1/);
  await expect(page.getByRole('heading', { name: 'Demo Service Challenge.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Competition settings saved.');
  const competitionPath = new URL(page.url()).pathname;
  const beforeActivation = await page.evaluate(async () => (await fetch('/api/demo')).json());
  expect(beforeActivation.board.competition.name).toBe(original.board.competition.name);
  await page.getByRole('link', { name: 'Back to admin' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Demo Service Challenge' });
  await row.getByRole('button', { name: 'Make active' }).click();
  await expect(row.locator('.pill')).toHaveText('Active');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Leaderboard' })
    .click();
  await expect(page.getByRole('heading', { name: 'Demo Service Challenge' })).toBeVisible();
  const created = await page.evaluate(async () => (await fetch('/api/demo')).json());
  expect(created.board.metrics.map((metric: { label: string }) => metric.label)).toEqual([
    'Orders',
  ]);
  await page.goto(competitionPath);
  await page.getByText('Edit metrics & report mapping', { exact: true }).click();
  const settings = page.locator('.competition-editor');
  await settings.getByLabel('Metric label', { exact: true }).first().fill('Completed orders');
  await settings.getByRole('button', { name: 'Continue', exact: true }).click();
  await settings.getByRole('button', { name: 'Continue', exact: true }).click();
  await settings.getByRole('button', { name: 'Save competition settings', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Competition settings saved.');
  expect(
    (await page.evaluate(async () => (await fetch('/api/demo')).json())).board.selected.label,
  ).toBe('Completed orders');
  const other = await browser.newContext();
  const visitor = await other.newPage();
  await visitor.goto('/demo');
  await expect(visitor.getByRole('heading', { name: 'Team Sales Challenge' })).toBeVisible();
  await other.close();
  expect(errors).toEqual([]);
  expect(mutations.every((path) => path.startsWith('/api/demo'))).toBe(true);
});

test('audience and cross-origin requests cannot create or activate competitions', async ({
  page,
  browser,
}) => {
  await page.goto('/demo/admin');
  const workspace = await page.evaluate(async () => (await fetch('/api/demo')).json());
  const audience = await browser.newContext();
  const invite = `room=${workspace.workspaceId}&invite=${workspace.shareToken}`;
  const origin = new URL(page.url()).origin;
  const create = await audience.request.post(`${origin}/api/demo/competition?${invite}`, {
    headers: { Origin: origin },
    multipart: { payload: '{}' },
  });
  expect(create.status()).toBe(403);
  const activate = await audience.request.post(`${origin}/api/demo/activate?${invite}`, {
    headers: { Origin: origin },
    form: { competition_id: '1' },
  });
  expect(activate.status()).toBe(403);
  const admin = await audience.request.get(`${origin}/demo/competitions?${invite}`);
  expect(admin.status()).toBe(403);
  const crossOrigin = await page.request.post(`${origin}/api/demo/competition`, {
    headers: { Origin: 'https://example.invalid' },
    multipart: { payload: '{}' },
  });
  expect(crossOrigin.status()).toBe(403);
  const invalid = await page.request.post(`${origin}/api/demo/competition`, {
    headers: { Origin: origin },
    multipart: { payload: '{"name":"Invalid"}' },
  });
  expect(invalid.status()).toBe(400);
  await audience.close();
});

test('sample competition can be reused as a new demo template', async ({ page }) => {
  await page.goto('/demo/admin');
  const editor = page.locator('.competition-editor');
  await editor.getByLabel('Competition name').fill('Copied demo challenge');
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor
    .getByLabel('Reuse a competition template')
    .selectOption({ label: 'Team Sales Challenge' });
  await expect(editor.getByLabel('Metric label', { exact: true })).toHaveCount(3);
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByRole('button', { name: 'Continue', exact: true }).click();
  await editor.getByRole('button', { name: 'Create competition', exact: true }).click();
  await expect(page).toHaveURL(/\/demo\/competitions\/\d+\?saved=1/);
  await expect(page.getByRole('heading', { name: 'Copied demo challenge.' })).toBeVisible();
});
