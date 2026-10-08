import { test, expect } from '@playwright/test';
import { authenticateAdmin } from './helpers/admin.ts';

test('admin privacy controls protect production while demos remain public and isolated', async ({
  page,
  browser,
}) => {
  await authenticateAdmin(page);
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const origin = 'http://127.0.0.1:4329';
  const disable = async () => {
    await page.request.post('/api/site-privacy', {
      headers: { Origin: origin },
      form: { action: 'save', password: '' },
    });
  };
  try {
    await page.goto('/admin');
    const privacy = page.locator('.site-privacy');
    await expect(privacy.getByRole('heading', { name: 'Site privacy' })).toBeVisible();
    await expect(privacy).toContainText('The site is public.');
    const wrongOrigin = await page.request.post('/api/site-privacy', {
      headers: { Origin: 'https://untrusted.example' },
      form: { action: 'save', enabled: 'true', password: 'visitor-test-password' },
      maxRedirects: 0,
    });
    expect(wrongOrigin.status()).toBe(403);
    const missingPassword = await page.request.post('/api/site-privacy', {
      headers: { Origin: origin },
      form: { action: 'save', enabled: 'true', password: '' },
      maxRedirects: 0,
    });
    expect(missingPassword.status()).toBe(303);
    expect(missingPassword.headers().location).toContain('error=');
    await visitor.goto('/');
    expect(new URL(visitor.url()).pathname).toBe('/');

    await privacy.getByLabel('Require a password to view the site').check();
    await privacy.locator('input[name=password]').fill('visitor-test-password');
    await privacy.getByRole('button', { name: 'Save site privacy' }).click();
    await expect(privacy).toContainText('The site is protected.');
    await expect(privacy.getByRole('status')).toHaveText('Site privacy settings saved.');
    await expect(privacy.locator('input[name=password]')).toHaveValue('');
    await visitor.goto('/archive');
    await expect(visitor).toHaveURL(/\/login\?/);
    const blocked = await visitor.request.get('/api/results?room=demo&invite=demo', {
      maxRedirects: 0,
    });
    expect(blocked.status()).toBe(401);
    expect(blocked.headers()['cache-control']).toBe('private, no-store');
    await visitor.goto('/admin/login');
    await expect(visitor.getByLabel('Admin passcode')).toBeVisible();

    await visitor.goto('/demo/admin');
    await expect(visitor.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
    await expect(visitor.getByRole('heading', { name: 'Site privacy' })).toHaveCount(0);
    const demoState = await visitor.request.get('/api/demo');
    expect(demoState.status()).toBe(200);
    const demoCredentialsCannotChangePrivacy = await visitor.request.post('/api/site-privacy', {
      headers: { Origin: origin },
      form: { action: 'save', password: '' },
      maxRedirects: 0,
    });
    expect([401, 403]).toContain(demoCredentialsCannotChangePrivacy.status());
    await visitor.goto('/archive');
    await expect(visitor).toHaveURL(/\/login\?/);
    await visitor.getByLabel('Site password', { exact: true }).fill('incorrect-password');
    await visitor.getByRole('button', { name: 'Sign in' }).click();
    await expect(visitor).toHaveURL(/\/login/);
    await visitor.getByLabel('Site password', { exact: true }).fill('visitor-test-password');
    await visitor.getByRole('button', { name: 'Sign in' }).click();
    await expect(visitor).toHaveURL(/\/archive$/);
    const cookies = await visitorContext.cookies();
    expect(cookies.find((cookie) => cookie.name === 'site_viewer')).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(cookies.find((cookie) => cookie.name === 'admin')).toBeUndefined();
    expect((await visitor.request.get('/api/results')).status()).toBe(403);
    expect((await visitor.request.get('/activity')).status()).toBe(200);
    await visitor.goto('/admin');
    await expect(visitor).toHaveURL(/\/admin\/login/);

    await privacy.getByRole('button', { name: 'Sign out all viewers' }).click();
    await expect(privacy.getByRole('status')).toContainText('All viewers have been signed out.');
    await visitor.goto('/archive');
    await expect(visitor).toHaveURL(/\/login\?/);
    await privacy.locator('input[name=password]').fill('rotated-viewer-password');
    await privacy.getByRole('button', { name: 'Save site privacy' }).click();
    await visitor.getByLabel('Site password', { exact: true }).fill('visitor-test-password');
    await visitor.getByRole('button', { name: 'Sign in' }).click();
    await expect(visitor).toHaveURL(/\/login/);
    await visitor.getByLabel('Site password', { exact: true }).fill('rotated-viewer-password');
    await visitor.getByRole('button', { name: 'Sign in' }).click();
    await expect(visitor).toHaveURL(/\/archive$/);
    const logout = await visitor.request.post('/api/site-logout', {
      headers: { Origin: origin },
      maxRedirects: 0,
    });
    expect(logout.status()).toBe(303);
    await visitor.goto('/archive');
    await expect(visitor).toHaveURL(/\/login\?/);
    await privacy.getByLabel('Require a password to view the site').uncheck();
    await privacy.getByRole('button', { name: 'Save site privacy' }).click();
    await expect(privacy).toContainText('The site is public.');
    await visitor.goto('/archive');
    await expect(visitor).toHaveURL(/\/archive$/);
  } finally {
    await disable();
    await visitorContext.close();
  }
});

test('Power Hour admission follows site privacy, revocation, and live changes', async ({
  page,
  browser,
}) => {
  await authenticateAdmin(page);
  const origin = 'http://127.0.0.1:4329';
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const demoContext = await browser.newContext();
  const demo = await demoContext.newPage();
  const privacy = async (enabled: boolean, password = '') => {
    const response = await page.request.post('/api/site-privacy', {
      headers: { Origin: origin },
      form: { action: 'save', ...(enabled ? { enabled: 'true' } : {}), password },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).not.toContain('error=');
  };
  const adminAction = async (form: Record<string, string>) => {
    const response = await page.request.post('/api/admin', {
      headers: { Origin: origin },
      form,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).not.toContain('error=');
  };
  try {
    await privacy(false);
    await adminAction({
      action: 'start',
      name: 'Site access Power Hour',
      metric_label: 'calls',
      duration_minutes: '60',
      password: 'power-hour-test-password',
    });
    await page.goto('/');
    await visitor.goto('/');
    await expect(visitor.getByLabel('Shared password')).toBeVisible();
    const sessionId = await visitor.evaluate(
      () => (document.querySelector('[x-data]') as any)._x_dataStack[0].session.id,
    );
    const forgedBypass = await visitor.request.post('/api/power-hour/join', {
      headers: { Origin: origin },
      form: {
        sessionId: String(sessionId),
        name: 'Forged bypass',
        requiresPowerHourPassword: 'false',
        bypassPassword: 'true',
      },
    });
    expect(forgedBypass.status()).toBe(400);
    expect((await forgedBypass.json()).error).toMatch(/password/i);

    // An admin can remain on the live page while privacy changes. Existing anonymous
    // visitors must instead authenticate before seeing or joining the protected site.
    await privacy(true, 'site-viewer-test-password');
    await expect(page.getByLabel('Shared password')).toBeHidden();
    await expect(visitor).toHaveURL(/\/login\?/);
    const anonymousJoin = await visitor.request.post('/api/power-hour/join', {
      headers: { Origin: origin },
      form: { sessionId: String(sessionId), name: 'Anonymous' },
      maxRedirects: 0,
    });
    expect(anonymousJoin.status()).toBe(401);
    await visitor.getByLabel('Site password', { exact: true }).fill('site-viewer-test-password');
    await visitor.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(visitor).toHaveURL(`${origin}/`);
    await expect(visitor.getByLabel('Shared password')).toBeHidden();
    await visitor.getByLabel('Your name').fill('Site Viewer');
    await expect(visitor.getByRole('button', { name: 'Join the Power Hour' })).toBeEnabled();
    await visitor.getByRole('button', { name: 'Join the Power Hour' }).click();
    await expect(visitor.locator('.live-grid')).toBeVisible();
    await visitor.locator('.tap-button').click();
    await expect(visitor.locator('.my-score')).toHaveText('1');

    // Public demos retain their own admission flow, and their credentials do not
    // grant production site access.
    await demo.goto('/demo');
    await demo.getByRole('button', { name: 'Start demo Power Hour' }).click();
    await expect(demo.getByLabel('Shared password')).toBeVisible();
    const demoCannotJoinProduction = await demo.request.post('/api/power-hour/join', {
      headers: { Origin: origin },
      form: { sessionId: String(sessionId), name: 'Demo visitor' },
      maxRedirects: 0,
    });
    expect(demoCannotJoinProduction.status()).toBe(401);
    await demo.getByLabel('Your name').fill('Demo Site Viewer');
    await demo.getByRole('button', { name: 'Join the Power Hour' }).click();
    await expect(demo.locator('.live-grid')).toBeVisible();

    const revoke = await page.request.post('/api/site-privacy', {
      headers: { Origin: origin },
      form: { action: 'revoke' },
      maxRedirects: 0,
    });
    expect(revoke.status()).toBe(303);
    await expect(visitor).toHaveURL(/\/login\?/);
    const revokedJoin = await visitor.request.post('/api/power-hour/join', {
      headers: { Origin: origin },
      form: { sessionId: String(sessionId), name: 'Revoked viewer' },
      maxRedirects: 0,
    });
    expect(revokedJoin.status()).toBe(401);

    await privacy(false);
    await expect(page.getByLabel('Shared password')).toBeVisible();
    await visitor.goto('/');
    const passwordRequiredAgain = await visitor.request.post('/api/power-hour/join', {
      headers: { Origin: origin },
      form: { sessionId: String(sessionId), name: 'Site Viewer' },
    });
    expect(passwordRequiredAgain.status()).toBe(400);
    const originalPasswordWorks = await visitor.request.post('/api/power-hour/join', {
      headers: { Origin: origin },
      form: {
        sessionId: String(sessionId),
        name: 'Site Viewer',
        password: 'power-hour-test-password',
      },
    });
    expect(originalPasswordWorks.status()).toBe(200);
  } finally {
    await privacy(false);
    await adminAction({ action: 'archive' });
    await visitorContext.close();
    await demoContext.close();
  }
});
