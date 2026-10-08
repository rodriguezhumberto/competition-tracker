import { ensure } from './assertions.ts';
import { dateOnly } from './calendar.ts';

export const CHICAGO_TIME_ZONE = 'America/Chicago';
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string) {
  let cached = formatters.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    // Bound the cache even when callers supply many different valid aliases.
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(timezone, cached);
  }
  return cached;
}

export function validTimezone(raw: unknown): string {
  ensure(typeof raw === 'string' && raw.length <= 80, 'Choose a timezone.');
  try {
    formatter(raw);
  } catch {
    throw new Error('Choose a valid IANA timezone, such as America/Chicago.');
  }
  return raw;
}

function clockParts(timezone: string, instant: Date | number) {
  return Object.fromEntries(
    formatter(timezone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
}

export function zonedClock(timezone: string, instant: Date | number = Date.now()): string {
  const parts = clockParts(timezone, instant);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function zonedReportTime(utc: string, timezone: string): string {
  const instant = new Date(utc);
  ensure(!Number.isNaN(instant.getTime()), 'Invalid stored report timestamp.');
  const parts = clockParts(timezone, instant);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

function parseClock(raw: unknown) {
  ensure(typeof raw === 'string', 'Report date and time are required.');
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      raw,
    );
  ensure(match, 'Use an ISO report datetime, optionally with an explicit UTC offset.');
  dateOnly(match[1]);
  ensure(+match[2] < 24 && +match[3] < 60 && +(match[4] || 0) < 60, 'Invalid report clock time.');
  const canonical = `${match[1]}T${match[2]}:${match[3]}:${match[4] || '00'}`;
  const wall = Date.parse(`${canonical}.${(match[5] || '').padEnd(3, '0')}Z`);
  const offset = match[6];
  if (offset && offset !== 'Z') {
    const [hours, minutes] = offset.slice(1).split(':').map(Number);
    ensure(hours <= 23 && minutes < 60, 'Invalid report UTC offset.');
  }
  return { raw, canonical, wall, offset };
}

export function resolveReportTime(raw: unknown, timezone: string): string {
  const parsed = parseClock(raw);
  if (parsed.offset) {
    const instant = new Date(parsed.raw);
    ensure(!Number.isNaN(instant.getTime()), 'Invalid report timestamp.');
    return instant.toISOString();
  }
  validTimezone(timezone);
  // Discover offsets on both sides of a possible transition. Fractional-hour
  // zones and historical offsets use the same resolution as Chicago.
  const offsets = new Set(
    [-2, -1, 0, 1, 2].map((day) => {
      const sample = parsed.wall + day * 86400000;
      return Date.parse(`${zonedClock(timezone, sample)}Z`) - Math.floor(sample / 1000) * 1000;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => parsed.wall - offset)
    .filter((instant) => zonedClock(timezone, instant) === parsed.canonical);
  ensure(candidates.length > 0, 'This clock time does not exist because of daylight saving time.');
  ensure(
    candidates.length === 1,
    'This clock time occurs twice. Include the printed UTC offset (for example -05:00 or -06:00).',
  );
  return new Date(candidates[0]).toISOString();
}

export function manualZonedTimestamp(
  wall: unknown,
  offset: unknown,
  timezone: string,
  allowedOffsets: string[],
): string {
  const parsed = parseClock(wall);
  ensure(!parsed.offset, 'Enter a wall clock without a UTC offset before choosing its offset.');
  ensure(
    typeof offset === 'string' && (offset === '' || allowedOffsets.includes(offset)),
    'Choose a valid Central daylight saving offset.',
  );
  if (!offset) return parsed.raw;
  const raw = `${parsed.raw}${offset}`;
  const instant = resolveReportTime(raw, timezone);
  ensure(
    zonedClock(timezone, new Date(instant)) === parsed.canonical,
    'The chosen CST or CDT offset does not match this Central clock time.',
  );
  return raw;
}
