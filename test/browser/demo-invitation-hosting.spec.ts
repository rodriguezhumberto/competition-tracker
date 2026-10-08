import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';

test('deployed invitation link, clipboard, QR code, and polling use the same public address', async ({
  page,
  context,
  browser,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('http://localhost:4329/admin');
  await page.getByLabel('Admin passcode').fill('6bfZQp8mJr5VvL9aT2cXH7nW');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Launch demo' }).click();
  await expect(page).toHaveURL(/\/demo\/admin$/);
  const field = page.getByLabel('Audience join link', { exact: true });
  const state = await page.evaluate(async () => (await fetch('/api/demo')).json());
  const expected = new URL('/demo', process.env.E2E_INVITE_ORIGIN || 'http://localhost:4329');
  expected.searchParams.set('room', state.workspaceId);
  expected.searchParams.set('invite', state.shareToken);
  expect(state.shareUrl).toBe(expected.toString());
  await expect(field).toHaveValue(expected.toString());
  await expect(page.getByRole('link', { name: 'Open audience join link' })).toHaveAttribute(
    'href',
    expected.toString(),
  );
  const svg = await QRCode.toString(expected.toString(), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
  });
  await expect(
    page.getByRole('img', { name: 'QR code for the audience join link' }),
  ).toHaveAttribute('src', `data:image/svg+xml,${encodeURIComponent(svg)}`);
  await page.getByRole('button', { name: 'Copy join link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected.toString());
  // A mode change publishes a fresh API state, exercising the same update path as polling.
  await page.getByRole('button', { name: 'Explore on your own' }).click();
  await page.getByRole('button', { name: 'Present to a group' }).click();
  await expect(field).toHaveValue(expected.toString());
  const audience = await browser.newContext();
  try {
    // Reach the running app locally with the headers supplied by an HTTPS proxy.
    const response = await audience.request.get(`/api/demo${expected.search}`, {
      headers: {
        'X-Forwarded-Host': expected.host,
        'X-Forwarded-Proto': expected.protocol.slice(0, -1),
      },
    });
    expect(response.status()).toBe(200);
    const invitedState = await response.json();
    expect(invitedState.workspaceId).toBe(state.workspaceId);
    expect(invitedState.role).toBe('audience');
    expect(invitedState.shareUrl).toBeUndefined();
  } finally {
    await audience.close();
  }
});
