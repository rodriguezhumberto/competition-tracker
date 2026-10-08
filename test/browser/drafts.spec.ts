import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { authenticateAdmin } from './helpers/admin.ts';
import { newMetric } from '../../src/lib/metrics.ts';
import { centralDate } from '../../src/lib/central-time.ts';

test('drafts require admin access and same-origin mutations, and discard invalidates proof and recovery', async ({
  page,
  browser,
}) => {
  await authenticateAdmin(page);
  const origin = { Origin: 'http://127.0.0.1:4329' };
  const created = await page.request.post('/api/competition', {
    headers: origin,
    form: {
      payload: JSON.stringify({
        name: 'Discard lifecycle',
        start_date: centralDate(Date.now() - 86400000),
        end_date: centralDate(Date.now() + 86400000),
        metrics: [{ ...newMetric(), label: 'Units' }],
      }),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  const image = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  const extracted = await page.request.post('/api/upload', {
    headers: origin,
    multipart: {
      competition_id: String(id),
      report: { name: 'draft.png', mimeType: 'image/png', buffer: image },
    },
  });
  expect(extracted.ok(), await extracted.text()).toBe(true);
  const draft = await extracted.json();
  const visitor = await browser.newContext();
  try {
    expect((await visitor.request.get('/api/drafts')).status()).toBe(403);
    expect((await visitor.request.get(`/api/drafts?token=${draft.token}`)).status()).toBe(403);
    expect(
      (
        await visitor.request.post('/api/drafts', {
          headers: origin,
          form: { payload: JSON.stringify({ action: 'discard', token: draft.token, revision: 1 }) },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post('/api/drafts', {
          headers: { Origin: 'https://other.example' },
          form: { payload: JSON.stringify({ action: 'discard', token: draft.token, revision: 1 }) },
        })
      ).status(),
    ).toBe(403);
    await page.goto(`/admin?draft=${draft.token}`);
    const upload = page.locator('.report-upload');
    await expect(upload.getByRole('heading', { name: 'Review extracted report' })).toBeVisible();
    await upload.getByRole('button', { name: 'Discard preview' }).click();
    await expect(upload.locator('.notice[role=status]')).toContainText('discarded');
    expect((await page.request.get(`/api/drafts?token=${draft.token}`)).status()).toBe(404);
    expect((await page.request.get(`/api/proof?draft=${draft.token}`)).status()).toBe(404);
    expect(
      (
        await page.request.post('/api/reports', {
          headers: origin,
          form: {
            payload: JSON.stringify({
              token: draft.token,
              revision: 1,
              confirmed: true,
              report: draft.report,
            }),
          },
        })
      ).status(),
    ).toBe(400);
    await page.reload();
    await expect(upload.getByRole('button', { name: 'Resume Discard lifecycle' })).toHaveCount(0);
  } finally {
    await visitor.close();
  }
});
