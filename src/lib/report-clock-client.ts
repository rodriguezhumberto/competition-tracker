import { zonedClock } from './report-time.ts';
import type { ReportInput } from './competition-store.ts';

export function pickerClock(timestamp: string, timezone: string): string {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return timestamp;
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return '';
  const milliseconds = instant.getUTCMilliseconds();
  return (
    zonedClock(timezone, instant) +
    (milliseconds ? `.${String(milliseconds).padStart(3, '0').replace(/0+$/, '')}` : '')
  );
}

type ClockContext = { report: ReportInput | null; timezone: string };

export const reportClockFields = {
  reportClock(this: ClockContext): string {
    return pickerClock(this.report?.generated_at || '', this.timezone);
  },
  updateReportClock(this: ClockContext, value: string) {
    if (this.report) this.report.generated_at = value;
  },
};
