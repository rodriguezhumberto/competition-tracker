import './competition-board-client.ts';
import { initCompactStandings } from './compact-standings-client.ts';
import Alpine from 'alpinejs';
interface Player {
  userId: number;
  name: string;
  clicks: number;
  flagged: boolean;
}
interface Session {
  id: number;
  name: string;
  metric_label: string;
  created_at: string;
  ends_at: string;
  status: 'active' | 'ended';
  results_until: string;
}
interface State {
  session: Session | null;
  scores: Player[];
  requiresPowerHourPassword?: boolean;
}
function redirectToSiteLogin() {
  const currentPath = location.pathname + location.search;
  const returnTo = currentPath.startsWith('//') || currentPath.includes('\\') ? '/' : currentPath;
  location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}
Alpine.data('powerHour', (initial: State) => ({
  session: initial.session,
  scores: initial.scores,
  escaped: false,
  connected: false,
  confirmed: false,
  scaleCeiling: 10,
  changedIds: [] as number[],
  changeTimer: 0,
  userId: 0,
  name: '',
  password: '',
  requiresPowerHourPassword: initial.requiresPowerHourPassword ?? true,
  joined: false,
  joining: false,
  error: '',
  remaining: '60:00',
  socket: null as WebSocket | null,
  clock: 0,
  retry: 0,
  stopped: false,
  init() {
    this.connect();
    this.clock = window.setInterval(() => {
      const seconds = Math.max(
        0,
        Math.ceil(
          ((this.session ? Date.parse(this.session.ends_at) : Date.now()) - Date.now()) / 1000,
        ),
      );
      this.remaining = `${Math.floor(seconds / 60)
        .toString()
        .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }, 250);
  },
  connect() {
    clearTimeout(this.retry);
    const previous = this.socket;
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    );
    this.socket = ws;
    this.connected = false;
    this.confirmed = false;
    previous?.close();
    ws.onopen = () => {
      if (this.socket === ws) this.error = '';
    };
    ws.onclose = (event) => {
      if (this.socket !== ws) return;
      this.connected = false;
      this.confirmed = false;
      if (!this.stopped && event.code === 1008) {
        this.stopped = true;
        redirectToSiteLogin();
        return;
      }
      if (!this.stopped) this.retry = window.setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => {
      if (this.socket === ws) this.error = 'Connection unavailable. Reconnecting…';
    };
    ws.onmessage = (message) => {
      if (this.socket !== ws) return;
      const data = JSON.parse(message.data);
      if (data.event === 'joined') {
        this.userId = data.userId;
        this.name = data.name;
        this.joined = true;
        this.confirmed = true;
        this.connected = true;
        this.joining = false;
        this.password = '';
        this.error = '';
        return;
      }
      if (data.event === 'error') {
        this.error = data.message;
        this.joining = false;
        return;
      }
      if ('session' in data) {
        if (
          typeof data.requiresPowerHourPassword === 'boolean' &&
          data.requiresPowerHourPassword !== this.requiresPowerHourPassword
        ) {
          this.requiresPowerHourPassword = data.requiresPowerHourPassword;
          this.password = '';
        }
        if (data.session?.id !== this.session?.id) {
          this.escaped = false;
          this.joined = false;
          this.confirmed = false;
          this.userId = 0;
          this.scaleCeiling = 10;
          this.changedIds = [];
        }
        this.connected = true;
        if (data.participant === false) {
          this.joined = false;
          this.confirmed = false;
          this.userId = 0;
          this.joining = false;
        }
        const previousScores = new Map(this.scores.map((person) => [person.userId, person.clicks]));
        this.changedIds = data.scores
          .filter(
            (person: Player) =>
              previousScores.has(person.userId) &&
              previousScores.get(person.userId) !== person.clicks,
          )
          .map((person: Player) => person.userId);
        clearTimeout(this.changeTimer);
        this.changeTimer = window.setTimeout(() => {
          this.changedIds = [];
        }, 450);
        this.session = data.session;
        this.scores = data.scores;
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
      }
    };
  },
  async join() {
    if (!this.session || this.ended || this.joining) return;
    this.error = '';
    this.joining = true;
    try {
      const form = new FormData();
      form.set('sessionId', String(this.session.id));
      form.set('name', this.name);
      if (this.requiresPowerHourPassword) form.set('password', this.password);
      const response = await fetch('/api/power-hour/join', { method: 'POST', body: form });
      if (response.status === 401) {
        this.stopped = true;
        clearTimeout(this.retry);
        this.socket?.close();
        redirectToSiteLogin();
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to join.');
      this.password = '';
      this.name = data.name;
      this.connect();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Unable to join.';
      this.joining = false;
    }
  },
  tap() {
    if (
      !this.connected ||
      !this.confirmed ||
      !this.joined ||
      !this.session ||
      this.ended ||
      Date.now() >= Date.parse(this.session.ends_at)
    )
      return;
    this.error = '';
    this.socket?.send(JSON.stringify({ action: 'increment', sessionId: this.session.id }));
  },
  get ended(): boolean {
    return this.session?.status === 'ended';
  },
  get myScore(): number {
    return this.scores.find((p) => p.userId === this.userId)?.clicks || 0;
  },
  destroy() {
    this.stopped = true;
    clearInterval(this.clock);
    clearTimeout(this.retry);
    clearTimeout(this.changeTimer);
    this.socket?.close();
  },
}));
Alpine.data('adminPowerHourLeaderboard', (initial: { sessionId: number; scores: Player[] }) => ({
  scores: initial.scores,
  connected: false,
  socket: null as WebSocket | null,
  retry: 0,
  stopped: false,
  init() {
    this.connect();
  },
  connect() {
    clearTimeout(this.retry);
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    );
    this.socket = ws;
    ws.onopen = () => {
      this.connected = true;
    };
    ws.onmessage = (message) => {
      if (this.socket !== ws) return;
      const data = JSON.parse(message.data);
      if ('session' in data)
        this.scores = data.session?.id === initial.sessionId ? data.scores : [];
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.connected = false;
      if (!this.stopped) this.retry = window.setTimeout(() => this.connect(), 2000);
    };
  },
  destroy() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
  },
}));
async function start() {
  if (document.querySelector('[data-demo-workspace]')) {
    const { registerDemo } = await import('./demo-client.ts');
    registerDemo(Alpine);
  }
  if (document.querySelector('[data-competition-admin]')) {
    const { registerCompetitionAdmin } = await import('./admin-client.ts');
    registerCompetitionAdmin(Alpine);
  }
  Alpine.start();
  initCompactStandings();
}
void start();
