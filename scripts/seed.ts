import { sqlite } from '../src/db/index.ts';
import { addCompetition, saveReport, getCompetitions } from '../src/lib/competition-store.ts';
import { newMetric } from '../src/lib/metrics.ts';
import { zonedClock } from '../src/lib/report-time.ts';
if (getCompetitions().length) throw new Error('Seed is only allowed on an empty database.');
const now = new Date();
const date = zonedClock('America/Chicago', now.getTime()).slice(0, 10);
const [year, month] = date.split('-').map(Number);
sqlite
  .transaction(() => {
    const competition = addCompetition({
      name: 'The monthly climb · demo',
      start_date: `${date.slice(0, 7)}-01`,
      end_date: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
      is_active: true,
      timezone: 'America/Chicago',
      official_metric_key: 'points',
      metrics: [{ ...newMetric('points'), label: 'Points', type: 'integer', precision: 0 }],
      profile: { identifier_label: 'Operator number', columns: { points: 'Number Sold' } },
    });
    saveReport(competition.id, {
      generated_at: now.toISOString(),
      period_start: date,
      period_end: date,
      rows: [1840, 1625, 1480, 1320, 1195, 1080, 965, 820].map((total, i) => ({
        participant_id: String(101 + i),
        values: { points: String(total) },
      })),
    });
  })
  .immediate();
console.log('Created a demo competition and 8 sample operator reports.');
sqlite.close();
