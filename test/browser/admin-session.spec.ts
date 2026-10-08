import { test, expect } from '@playwright/test';

test('logout rejects replay of an admin cookie copied before logout', async ({
  request,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const login = await request.post('/admin/login', {
    headers: { Origin: origin },
    form: { passcode: '6bfZQp8mJr5VvL9aT2cXH7nW' },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  const state = await request.storageState();
  const cookie = state.cookies.find((item) => item.name === 'admin');
  expect(cookie).toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Strict');
  const copiedCookie = `admin=${cookie!.value}`;
  const before = await request.get('/admin', {
    headers: { Cookie: copiedCookie },
    maxRedirects: 0,
  });
  expect(before.status()).toBe(200);
  const logout = await request.post('/api/admin', {
    headers: { Origin: origin, Cookie: copiedCookie },
    form: { action: 'logout' },
    maxRedirects: 0,
  });
  expect(logout.status()).toBe(303);
  const replay = await request.get('/admin', {
    headers: { Cookie: copiedCookie },
    maxRedirects: 0,
  });
  expect(replay.status()).toBe(302);
  expect(replay.headers().location).toBe('/admin/login');
  const replayWrite = await request.post('/api/admin', {
    headers: { Origin: origin, Cookie: copiedCookie },
    form: { action: 'logout' },
    maxRedirects: 0,
  });
  expect(replayWrite.status()).toBe(403);
});
