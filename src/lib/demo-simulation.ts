import { sqlite } from '../db/index.ts';
import { withDemo } from './demo-workspaces.ts';
import { demoPassword } from './demo-seed.ts';
import {
  activeSession,
  joinSession,
  startSession,
  participantForToken,
  sessionParticipants,
} from './store.ts';
import { ensure, participantName } from './validation.ts';
import { events } from './events.ts';
import { submitPowerHourPoint, type SubmissionHistory } from './power-hour-submissions.ts';

export const DEMO_POWER_HOUR_PASSWORD = demoPassword;
const names = [
  'Alex Demo',
  'Jordan Demo',
  'Taylor Demo',
  'Morgan Demo',
  'Sam Demo',
  'Casey Demo',
  'Riley Demo',
  'Jamie Demo',
];
const patterns = [
  [8, 7, 4, 3, 2],
  [5, 5, 5, 5, 5],
  [2, 3, 5, 7, 8],
  [4, 4, 5, 4, 4],
  [3, 5, 4, 5, 4],
  [4, 3, 4, 5, 5],
  [2, 4, 5, 4, 5],
  [3, 3, 4, 4, 5],
];
type ScheduledEvent = { at: number; bot: number; join?: boolean };
type Simulation = {
  sessionId: number;
  paused: boolean;
  running: boolean;
  cursor: number;
  schedule: ScheduledEvent[];
  scheduledUntil?: number;
  users: (number | null)[];
  histories: Record<string, SubmissionHistory>;
};
const timerKey = Symbol.for('rally.demo-simulation');
const shared = globalThis as typeof globalThis & {
  [timerKey]?: { workspaces: Set<string>; timer: ReturnType<typeof setInterval> };
};

function read(): Simulation | null {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS demo_simulation (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)',
  );
  const row = sqlite.prepare('SELECT state FROM demo_simulation WHERE id = 1').get() as
    { state: string } | undefined;
  return row ? JSON.parse(row.state) : null;
}
function save(state: Simulation) {
  sqlite
    .prepare(
      'INSERT INTO demo_simulation(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state',
    )
    .run(JSON.stringify(state));
}
function wake(workspaceId: string) {
  if (!shared[timerKey]) {
    const workspaces = new Set<string>();
    const timer = setInterval(() => {
      for (const id of workspaces) {
        try {
          advanceDemoSimulation(id);
        } catch {
          // Expired/reset workspaces cannot leave a live runner behind.
          workspaces.delete(id);
        }
      }
      if (!workspaces.size) {
        clearInterval(timer);
        delete shared[timerKey];
      }
    }, 500);
    timer.unref();
    shared[timerKey] = { workspaces, timer };
  }
  shared[timerKey]!.workspaces.add(workspaceId);
}

export function startDemoSimulation(workspaceId: string) {
  withDemo(workspaceId, () => {
    sqlite
      .transaction(() => {
        read();
        const session = startSession({
          name: 'Demo Power Hour',
          metric_label: 'points',
          password: DEMO_POWER_HOUR_PASSWORD,
          duration_minutes: 5,
        });
        const start = Date.parse(session.created_at);
        const schedule: ScheduledEvent[] = [];
        names.forEach((_, bot) => {
          schedule.push({ at: start + bot * 2000, bot, join: true });
          patterns[bot].forEach((count, minute) => {
            for (let point = 0; point < count; point++) {
              // Safe spacing even across minute boundaries, with a staggered first minute.
              const span = minute === 0 ? 42000 : 60000;
              const offset = minute === 0 ? 17000 : 0;
              schedule.push({
                at: start + minute * 60000 + offset + ((point + 0.5) * span) / count,
                bot,
              });
            }
          });
        });
        schedule.sort((a, b) => a.at - b.at || a.bot - b.bot);
        save({
          sessionId: session.id,
          paused: false,
          running: true,
          cursor: 0,
          schedule,
          scheduledUntil: start + 300000,
          users: names.map(() => null),
          histories: {},
        });
      })
      .immediate();
  });
  advanceDemoSimulation(workspaceId);
  wake(workspaceId);
}

export function advanceDemoSimulation(workspaceId: string, now = Date.now()) {
  withDemo(workspaceId, () => {
    let changed = false;
    sqlite
      .transaction(() => {
        const state = read();
        if (!state?.running) {
          shared[timerKey]?.workspaces.delete(workspaceId);
          return;
        }
        const session = activeSession();
        if (session?.id !== state.sessionId) {
          state.running = false;
          save(state);
          shared[timerKey]?.workspaces.delete(workspaceId);
          return;
        }
        const start = Date.parse(session.created_at);
        const endsAt = Date.parse(session.ends_at);
        const scheduledUntil = state.scheduledUntil ?? start + 300000;
        if (endsAt > scheduledUntil && now >= scheduledUntil - 60000) {
          // Generate at most one extra minute per tick. After a restart, skip unscheduled
          // past minutes rather than materializing a large backlog.
          const minuteStart = Math.max(
            scheduledUntil,
            start + Math.floor((now - start) / 60000) * 60000,
          );
          const minute = Math.floor((minuteStart - start) / 60000);
          names.forEach((_, bot) => {
            const count = 4 + ((bot + minute) % 3);
            for (let point = 0; point < count; point++) {
              const at = minuteStart + ((point + 0.5) * 60000) / count;
              if (at < endsAt) state.schedule.push({ at, bot });
            }
          });
          state.schedule.sort((a, b) => a.at - b.at || a.bot - b.bot);
          state.scheduledUntil = minuteStart + 60000;
        }
        while (state.cursor < state.schedule.length && state.schedule[state.cursor].at <= now) {
          const event = state.schedule[state.cursor++];
          if (event.join) {
            state.users[event.bot] = joinSession(
              state.sessionId,
              DEMO_POWER_HOUR_PASSWORD,
              names[event.bot],
            ).userId;
            changed = true;
          } else if (!state.paused && now - event.at < 3000) {
            const userId = state.users[event.bot];
            if (userId) {
              const history = (state.histories[userId] ??= { start: now, count: 0, recent: [] });
              submitPowerHourPoint(userId, state.sessionId, history, now);
              changed = true;
            }
          }
        }
        // Keep long presentations' persisted schedules bounded as completed events expire.
        if (state.cursor > 256) {
          state.schedule = state.schedule.slice(state.cursor);
          state.cursor = 0;
        }
        save(state);
      })
      .immediate();
    if (changed) events.emit('power-hour-change');
  });
}

export function pauseDemoSimulation(workspaceId: string, paused: boolean) {
  advanceDemoSimulation(workspaceId);
  withDemo(workspaceId, () => {
    const state = read();
    if (state) {
      state.paused = paused;
      save(state);
    }
  });
}
export function demoSimulationState(workspaceId: string): { paused: boolean; running: boolean } {
  const result = withDemo(workspaceId, () => {
    const state = read();
    const running = !!state?.running && activeSession()?.id === state.sessionId;
    return { paused: !!state?.paused, running };
  });
  if (result.running) wake(workspaceId);
  return result;
}
export function stopDemoSimulation(workspaceId: string) {
  shared[timerKey]?.workspaces.delete(workspaceId);
  withDemo(workspaceId, () => {
    const state = read();
    if (state) {
      state.running = false;
      save(state);
    }
  });
}

// Visitors and bots both persist their history, so reconnects retain the same review rules.
export function submitDemoPoint(workspaceId: string, userId: number, sessionId: number) {
  withDemo(workspaceId, () => {
    sqlite
      .transaction(() => {
        let state = read();
        if (!state || state.sessionId !== sessionId) {
          state = {
            sessionId,
            paused: false,
            running: false,
            cursor: 0,
            schedule: [],
            users: [],
            histories: {},
          };
        }
        const now = Date.now();
        const history = (state.histories[userId] ??= { start: now, count: 0, recent: [] });
        submitPowerHourPoint(userId, sessionId, history, now);
        save(state);
      })
      .immediate();
    events.emit('power-hour-change');
  });
}
export function triggerDemoReview(workspaceId: string) {
  advanceDemoSimulation(workspaceId);
  withDemo(workspaceId, () => {
    sqlite
      .transaction(() => {
        const state = read();
        if (!state?.running || activeSession()?.id !== state.sessionId)
          throw new Error('Start a demo Power Hour first.');
        const userId = state.users[0];
        if (!userId) throw new Error('The first simulated participant has not joined yet.');
        const now = Date.now();
        const history = (state.histories[userId] ??= { start: now, count: 0, recent: [] });
        for (let i = 0; i < 11; i++) submitPowerHourPoint(userId, state.sessionId, history, now);
        save(state);
      })
      .immediate();
    events.emit('power-hour-change');
  });
}

// Keep seats and names available for the staggered bots before they join.
export function joinDemoParticipant(
  workspaceId: string,
  sessionId: number,
  rawName: unknown,
  existingToken: unknown = null,
) {
  return withDemo(workspaceId, () =>
    sqlite
      .transaction(() => {
        const name = participantName(rawName);
        ensure(
          !names.some(
            (botName) => botName.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
          ),
          'That name is reserved for a simulated participant. Choose another name.',
        );
        const existing = participantForToken(existingToken, sessionId);
        if (!existing) {
          const state = read();
          const botIds = new Set(
            state?.sessionId === sessionId ? state.users.filter((id) => id !== null) : [],
          );
          const audience = sessionParticipants(sessionId).filter(
            (member) => !botIds.has(member.userId),
          );
          ensure(
            audience.length < 12,
            'This demo already has 12 audience participants. Start your own public demo to join.',
          );
        }
        return joinSession(sessionId, DEMO_POWER_HOUR_PASSWORD, name, existingToken);
      })
      .immediate(),
  );
}
