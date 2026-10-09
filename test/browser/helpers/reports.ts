import { expect, type Page } from '@playwright/test';
import { centralDate } from '../../../src/lib/central-time.ts';
import { newMetric } from '../../../src/lib/metrics.ts';

export async function ensureReportCompetition(page: Page) {
  const choices = page.locator(
    '.report-upload[data-report-workflow=competition] select[name="competition_id"] option',
  );
  if ((await choices.count()) > 1) return;
  const response = await page.request.post('/api/competition', {
    headers: { Origin: new URL(page.url()).origin },
    form: {
      payload: JSON.stringify({
        name: 'Image processing test',
        start_date: centralDate(Date.now() - 86400000),
        end_date: centralDate(Date.now() + 86400000),
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
  expect(response.ok(), await response.text()).toBe(true);
  await page.reload();
}
