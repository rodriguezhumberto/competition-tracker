import { centralClock } from './central-time.ts';

export function suggestedPowerHourName(instant: Date | number = Date.now()): string {
  const hour = Number(centralClock(instant).slice(11, 13));
  const label =
    hour < 5 || hour >= 22
      ? 'Late Night'
      : hour < 8
        ? 'Early Morning'
        : hour < 12
          ? 'Morning'
          : hour < 14
            ? 'Midday'
            : hour < 18
              ? 'Afternoon'
              : 'Evening';
  return `${label} Power Hour`;
}
