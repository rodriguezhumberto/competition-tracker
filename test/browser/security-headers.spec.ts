import { test, expect } from '@playwright/test';

test('public, demo, API and redirect responses prevent framing and set safe browser headers', async ({
  request,
}) => {
  for (const path of ['/', '/demo', '/privacy', '/api/site-privacy', '/admin']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  }
});

test('browser blocks embedding the public standings in an iframe', async ({ page, baseURL }) => {
  const violations: string[] = [];
  page.on('console', (message) => violations.push(message.text()));
  await page.goto('/privacy');
  await page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.append(frame);
  }, baseURL!);
  await expect
    .poll(() => violations.some((message) => /frame-ancestors|X-Frame-Options/i.test(message)))
    .toBe(true);
});
