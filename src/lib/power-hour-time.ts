export const FINAL_REPORT_GRACE_MS = 5 * 60000;

export function powerHourTimingWarning(timestamp: string, endsAt: string): string | null {
  return Date.parse(timestamp) > Date.parse(endsAt) + FINAL_REPORT_GRACE_MS
    ? 'Report is more than 5 minutes after the cutoff. Totals may include extra activity.'
    : null;
}
