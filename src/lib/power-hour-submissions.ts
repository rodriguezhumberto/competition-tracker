import { incrementScore } from './store.ts';
import { ensure } from './validation.ts';

export type SubmissionHistory = {
  start: number;
  count: number;
  recent: number[];
};

// Shared by real taps and simulated participants. History can be persisted by callers.
export function submitPowerHourPoint(
  userId: number,
  sessionId: number,
  history: SubmissionHistory,
  now = Date.now(),
) {
  if (now - history.start >= 1000) {
    history.start = now;
    history.count = 0;
  }
  history.count++;
  ensure(history.count <= 15, 'Tap limit reached. Please slow down.');
  history.recent = history.recent.filter((time) => time > now - 60000);
  incrementScore(userId, sessionId, history.recent.length >= 10 || history.count > 10);
  history.recent.push(now);
}

export class PowerHourSubmissionTracker {
  private histories = new Map<number, SubmissionHistory>();

  reset() {
    this.histories.clear();
  }

  submit(userId: number, sessionId: number, now = Date.now()) {
    let history = this.histories.get(userId);
    if (!history) {
      history = { start: now, count: 0, recent: [] };
      this.histories.set(userId, history);
    }
    submitPowerHourPoint(userId, sessionId, history, now);
  }
}
