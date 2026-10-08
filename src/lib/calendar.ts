import { ensure } from './assertions.ts';

export function dateOnly(value: unknown): string {
  ensure(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    'Use a date in YYYY-MM-DD format.',
  );
  const date = new Date(`${value}T00:00:00.000Z`);
  ensure(
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value,
    'Invalid calendar date.',
  );
  return value;
}

// Calendar dates are independent of the timezone used to choose "today".
export function calendarWeek(date: string): { start: string; end: string } {
  dateOnly(date);
  const monday = new Date(`${date}T00:00:00.000Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}
