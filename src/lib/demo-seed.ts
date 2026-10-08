import { addCompetition } from './competition-config.ts';
import { newMetric } from './metrics.ts';
import { saveReport } from './report-store.ts';
import { startSession, joinSession, incrementScore, archiveSession } from './store.ts';
import { db } from '../db/index.ts';
import { power_hour_sessions } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { zonedClock } from './report-time.ts';

export const demoNames = ['Avery', 'Jordan', 'Morgan', 'Riley', 'Casey', 'Taylor', 'Quinn', 'Sam'];
export const demoPassword = 'demo-power-hour';

// Use the same validators, scaled metric arithmetic and scoring stores as the live site.
export function seedDemoWorkspace() {
  const now = new Date(Date.now());
  const today = zonedClock('America/Chicago', now.getTime()).slice(0, 10);
  const localCalendar = Date.parse(`${today}T12:00:00Z`);
  const date = (days: number) =>
    new Date(localCalendar + days * 86400000).toISOString().slice(0, 10);
  const competition = addCompetition({
    name: 'Team Sales Challenge',
    start_date: date(-7),
    end_date: date(7),
    is_active: true,
    timezone: 'America/Chicago',
    official_metric_key: 'items',
    profile: { identifier_label: 'Participant', columns: {} },
    metrics: [
      { ...newMetric('items'), label: 'Items sold', type: 'integer', precision: 0 },
      { ...newMetric('sales'), label: 'Sales', type: 'currency', precision: 2 },
      {
        ...newMetric('conversion'),
        label: 'Conversion %',
        type: 'decimal',
        precision: 1,
        mode: 'latest',
      },
    ],
  });
  for (let day = -4; day <= 0; day++) {
    const reportDate = date(day);
    saveReport(competition.id, {
      generated_at: day === 0 ? now.toISOString() : `${reportDate}T23:00:00Z`,
      period_start: reportDate,
      period_end: reportDate,
      rows: demoNames.map((name, i) => ({
        participant_id: name,
        values: {
          items: String(22 + ((i * 7 + day * 3 + 100) % 27)),
          sales: (180 + i * 31 + (day + 4) * 19.25).toFixed(2),
          conversion: (32 + i * 1.3 + (day + 4) * 0.8).toFixed(1),
        },
      })),
    });
  }
  const session = startSession({
    name: 'Friday Power Hour',
    metric_label: 'points',
    password: demoPassword,
  });
  demoNames.forEach((name, i) => {
    const participant = joinSession(session.id, demoPassword, name);
    for (let points = 0; points < 20 + ((i * 13) % 45); points++)
      incrementScore(participant.userId, session.id);
  });
  archiveSession();
  db.update(power_hour_sessions)
    .set({
      competition_id: competition.id,
      created_at: new Date(now.getTime() - 86400000 - 3600000).toISOString(),
      ends_at: new Date(now.getTime() - 86400000).toISOString(),
    })
    .where(eq(power_hour_sessions.id, session.id))
    .run();
}
