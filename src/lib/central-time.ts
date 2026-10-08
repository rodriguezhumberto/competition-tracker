import {
  CHICAGO_TIME_ZONE,
  zonedClock,
  zonedReportTime,
  resolveReportTime,
  manualZonedTimestamp,
} from './time.ts';
export { calendarWeek as centralWeek } from './calendar.ts';
export const REPORT_TIME_ZONE = CHICAGO_TIME_ZONE;
export function centralDate(instant: Date | number = Date.now()): string {
  return centralClock(instant).slice(0, 10);
}
export function centralClock(instant: Date | number = Date.now()): string {
  return zonedClock(REPORT_TIME_ZONE, instant);
}
export function centralReportTime(utc: string): string {
  return zonedReportTime(utc, REPORT_TIME_ZONE);
}
export function resolveCentralClock(wall: string): string {
  return resolveReportTime(wall, REPORT_TIME_ZONE);
}
export function manualReportTimestamp(wall: unknown, offset: unknown): string {
  return manualZonedTimestamp(wall, offset, REPORT_TIME_ZONE, ['-05:00', '-06:00']);
}
