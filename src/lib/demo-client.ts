import type AlpineType from 'alpinejs';
import type { leaderboard } from './leaderboard.ts';
type Player = { userId: number; name: string; clicks: number; flagged: boolean };
type Session = {
  id: number;
  name: string;
  metric_label: string;
  ends_at: string;
  status: string;
  results_until: string;
};
type DemoState = {
  workspaceId: string;
  role: 'owner' | 'audience';
  mode: 'public' | 'presenter';
  shareToken?: string;
  shareUrl?: string;
  board: ReturnType<typeof leaderboard>;
  session: Session | null;
  scores: Player[];
  participant: { userId: number; name: string } | null;
  simulation: { paused: boolean; running: boolean };
  archives: (Session & { scores: Player[] })[];
};
const query = new URLSearchParams(location.search);
const audienceLink = query.has('room') || query.has('invite');
let latest: DemoState | null = null;
let pollTimer = 0;
let stopped = false;
let started = false;
let queue: Promise<unknown> = Promise.resolve();
let abort: AbortController | null = null;
const listeners = new Set<(state: DemoState) => void>();
const failures = new Set<(error: string) => void>();
function publish(state: DemoState) {
  latest = state;
  listeners.forEach((listener) => listener(state));
  window.dispatchEvent(new CustomEvent('rally-demo-state', { detail: state }));
}
function notifyError(message: string) {
  failures.forEach((listener) => listener(message));
}
function schedule() {
  clearTimeout(pollTimer);
  if (!stopped) pollTimer = window.setTimeout(poll, 1000);
}
async function fetchState(action?: string, payload: Record<string, unknown> = {}) {
  const credentials: Record<string, string> = {};
  if (audienceLink) {
    credentials.room = query.get('room') || '';
    credentials.invite = query.get('invite') || '';
  }
  const filters: Record<string, string> = {};
  const currentQuery = new URLSearchParams(location.search);
  for (const key of ['metric', 'period', 'item'])
    if (currentQuery.has(key)) filters[key] = currentQuery.get(key)!;
  abort = new AbortController();
  const response = await fetch(
    action ? '/api/demo' : `/api/demo?${new URLSearchParams({ ...credentials, ...filters })}`,
    {
      method: action ? 'POST' : 'GET',
      signal: abort.signal,
      credentials: 'same-origin',
      ...(action
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...credentials, ...filters, ...payload }),
          }
        : {}),
    },
  );
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 403 && audienceLink) stopped = true;
    throw new Error(data.error || 'Unable to update the demo.');
  }
  publish(data as DemoState);
  return data as DemoState;
}
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => {});
  return result;
}
async function poll() {
  if (stopped) return;
  try {
    await enqueue(() => (stopped ? Promise.resolve(latest) : fetchState()));
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'AbortError'))
      notifyError(cause instanceof Error ? cause.message : 'Reconnecting to the demo…');
  } finally {
    schedule();
  }
}
function connect(
  initial: DemoState,
  update: (state: DemoState) => void,
  failure: (message: string) => void,
) {
  listeners.add(update);
  failures.add(failure);
  update(latest || initial);
  if (!started) {
    latest = initial;
    started = true;
    schedule();
  }
  return () => {
    listeners.delete(update);
    failures.delete(failure);
  };
}
async function perform(action: string, payload: Record<string, unknown> = {}) {
  clearTimeout(pollTimer);
  try {
    return await enqueue(() => fetchState(action, payload));
  } finally {
    schedule();
  }
}
window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(pollTimer);
  abort?.abort();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    stopped = false;
    schedule();
  }
});

export function registerDemo(Alpine: typeof AlpineType) {
  Alpine.data('demoPowerHour', (initial: DemoState) => ({
    session: initial.session,
    scores: initial.scores,
    escaped: false,
    connected: true,
    confirmed: !!initial.participant,
    scaleCeiling: 10,
    changedIds: [] as number[],
    changeTimer: 0,
    userId: initial.participant?.userId || 0,
    name: initial.participant?.name || '',
    password: 'demo-power-hour',
    joined: !!initial.participant,
    joining: false,
    error: '',
    remaining: '05:00',
    clock: 0,
    pendingTap: false,
    disconnect: null as null | (() => void),
    init() {
      this.disconnect = connect(
        initial,
        (state) => this.apply(state),
        (message) => {
          this.connected = false;
          this.confirmed = false;
          this.error = message;
        },
      );
      this.clock = window.setInterval(() => this.updateClock(), 250);
      this.updateClock();
    },
    apply(state: DemoState) {
      if (state.session?.id !== this.session?.id) {
        this.escaped = false;
        this.scaleCeiling = 10;
        this.changedIds = [];
        this.password = 'demo-power-hour';
      }
      const previous = new Map(this.scores.map((person) => [person.userId, person.clicks]));
      this.changedIds = state.scores
        .filter(
          (person) => previous.has(person.userId) && previous.get(person.userId) !== person.clicks,
        )
        .map((person) => person.userId);
      clearTimeout(this.changeTimer);
      this.changeTimer = window.setTimeout(() => {
        this.changedIds = [];
      }, 450);
      this.session = state.session;
      this.scores = state.scores;
      this.userId = state.participant?.userId || 0;
      if (state.participant) this.name = state.participant.name;
      this.joined = !!state.participant;
      this.confirmed = !!state.participant;
      this.connected = true;
      this.error = '';
      const peak = Math.max(0, ...this.scores.map((person) => person.clicks));
      while (peak >= this.scaleCeiling) {
        const magnitude = 10 ** Math.floor(Math.log10(this.scaleCeiling));
        this.scaleCeiling =
          this.scaleCeiling < 2 * magnitude
            ? 2 * magnitude
            : this.scaleCeiling < 5 * magnitude
              ? 5 * magnitude
              : 10 * magnitude;
      }
      this.updateClock();
    },
    updateClock() {
      const seconds = Math.max(
        0,
        Math.ceil(
          ((this.session ? Date.parse(this.session.ends_at) : Date.now()) - Date.now()) / 1000,
        ),
      );
      this.remaining = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    },
    async join() {
      if (!this.session || this.ended || this.joining) return;
      this.joining = true;
      this.error = '';
      try {
        await perform('join', {
          sessionId: this.session.id,
          name: this.name,
          password: this.password,
        });
        this.password = '';
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : 'Unable to join.';
      } finally {
        this.joining = false;
      }
    },
    async tap() {
      if (
        !this.session ||
        !this.connected ||
        !this.confirmed ||
        this.ended ||
        this.pendingTap ||
        Date.now() >= Date.parse(this.session.ends_at)
      )
        return;
      this.pendingTap = true;
      this.error = '';
      try {
        await perform('increment', { sessionId: this.session.id });
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : 'Unable to add a point.';
      } finally {
        this.pendingTap = false;
      }
    },
    get ended(): boolean {
      return this.session?.status === 'ended';
    },
    get myScore(): number {
      return this.scores.find((person) => person.userId === this.userId)?.clicks || 0;
    },
    destroy() {
      this.disconnect?.();
      clearInterval(this.clock);
      clearTimeout(this.changeTimer);
    },
  }));
  Alpine.data(
    'demoAdminLeaderboard',
    (initial: {
      sessionId: number;
      metricLabel?: string;
      initialScores?: Player[];
      scores?: Player[];
    }) => ({
      scores: initial.initialScores || initial.scores || [],
      connected: true,
      disconnect: null as null | (() => void),
      init() {
        const update = (state: DemoState) => {
          this.scores = state.session?.id === initial.sessionId ? state.scores : [];
          this.connected = true;
        };
        const failure = () => {
          this.connected = false;
        };
        listeners.add(update);
        failures.add(failure);
        if (latest) update(latest);
        if (!started) {
          started = true;
          schedule();
        }
        this.disconnect = () => {
          listeners.delete(update);
          failures.delete(failure);
        };
      },
      destroy() {
        this.disconnect?.();
      },
    }),
  );
  Alpine.data('demoToolbar', (initial: DemoState) => ({
    state: initial,
    role: initial.role,
    mode: initial.mode,
    session: initial.session,
    simulation: initial.simulation,
    shareToken: initial.shareToken || '',
    workspaceId: initial.workspaceId,
    busy: false,
    error: '',
    copied: false,
    disconnect: null as null | (() => void),
    init() {
      this.disconnect = connect(
        initial,
        (state) => {
          this.state = state;
          this.role = state.role;
          this.mode = state.mode;
          this.session = state.session;
          this.simulation = state.simulation;
          this.shareToken = state.shareToken || '';
          this.workspaceId = state.workspaceId;
          this.error = '';
        },
        (message) => {
          this.error = message;
        },
      );
    },
    get active(): boolean {
      return (
        !!this.session &&
        this.session.status === 'active' &&
        Date.parse(this.session.ends_at) > Date.now()
      );
    },
    get shareUrl(): string {
      return this.state.shareUrl || '';
    },
    async action(action: string, payload: Record<string, unknown> = {}) {
      if (this.busy) return;
      this.busy = true;
      this.error = '';
      try {
        await perform(action, {
          ...(this.session ? { sessionId: this.session.id } : {}),
          ...payload,
        });
        if (
          action === 'reset' ||
          (location.pathname.replace(/\/$/, '') === '/demo/admin' &&
            ['start', 'extend', 'end'].includes(action))
        )
          location.reload();
      } catch (cause) {
        this.error = cause instanceof Error ? cause.message : 'Unable to complete that action.';
      } finally {
        this.busy = false;
      }
    },
    async copyInvite() {
      try {
        await navigator.clipboard.writeText(this.shareUrl);
        this.copied = true;
        window.setTimeout(() => {
          this.copied = false;
        }, 2000);
      } catch {
        this.error = 'Copy the audience link from the field to share it.';
      }
    },
    destroy() {
      this.disconnect?.();
    },
  }));
}
