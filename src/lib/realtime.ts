import type { IncomingMessage, Server } from 'node:http';
import { isIP } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { hashParticipantToken, isAdminCookieHeader, participantTokenFromCookie } from './auth.ts';
import { events } from './events.ts';
import { participantForToken, sessionParticipants, sessionState, snapshot } from './store.ts';
import { ensure, positiveId } from './validation.ts';
import { PowerHourSubmissionTracker } from './power-hour-submissions.ts';
import { getSitePrivacy, siteAccessAllowed } from './site-access.ts';

type RealtimeLimits = {
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxBufferedBytes: number;
  heartbeatMs: number;
};

const defaultLimits: RealtimeLimits = {
  maxConnections: 512,
  maxConnectionsPerIp: 128,
  maxBufferedBytes: 256 * 1024,
  heartbeatMs: 30_000,
};

// Only explicitly trusted proxy peers may supply client addresses. Nginx must
// overwrite X-Forwarded-For, rather than append an untrusted incoming value.
export function realtimeClientIp(request: IncomingMessage): string {
  const peer = (request.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const trusted = (process.env.TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => isIP(address));
  const forwarded = request.headers['x-forwarded-for'];
  const hostname = process.env.PRODUCTION_HOSTNAME;
  if (
    trusted.includes(peer) &&
    hostname &&
    request.headers.host === hostname &&
    request.headers['x-forwarded-host'] === hostname &&
    request.headers['x-forwarded-proto'] === 'https' &&
    typeof forwarded === 'string' &&
    isIP(forwarded)
  )
    return forwarded.replace(/^::ffff:/, '');
  return peer;
}

export function attachRealtime(server: Server, overrides: Partial<RealtimeLimits> = {}) {
  const limits = { ...defaultLimits, ...overrides };
  for (const limit of Object.values(limits))
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid realtime limit.');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const initialSession = sessionState();
  let previousId: number | null = initialSession?.id || null;
  let previousEnd = initialSession?.ends_at || null;
  let previousStatus = initialSession?.status || null;
  let previousPasswordRequired = !getSitePrivacy().enabled;
  const submissions = new PowerHourSubmissionTracker();
  const members = new Map<WebSocket, string>();
  const adminCookies = new Map<WebSocket, string | undefined>();
  const adminClients = new Set<WebSocket>();
  const accessAllowed = (client: WebSocket) =>
    siteAccessAllowed(adminCookies.get(client)) &&
    (!adminClients.has(client) || isAdminCookieHeader(adminCookies.get(client)));
  const connectionsByIp = new Map<string, number>();
  const alive = new Map<WebSocket, boolean>();
  const send = (client: WebSocket, data: unknown) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(data);
    if (client.bufferedAmount + Buffer.byteLength(payload) > limits.maxBufferedBytes) {
      client.terminate();
      return;
    }
    client.send(payload, (error) => {
      if (error) client.terminate();
    });
  };
  const broadcast = () => {
    const state = snapshot();
    const requiresPowerHourPassword = !state.session?.report_mode && !getSitePrivacy().enabled;
    previousPasswordRequired = !getSitePrivacy().enabled;
    const currentId = state.session?.id || null;
    const event =
      currentId && currentId !== previousId
        ? 'power_hour_started'
        : state.session?.status === 'ended' && previousStatus === 'active'
          ? 'power_hour_ended'
          : !currentId && previousId
            ? 'power_hour_closed'
            : 'scores_updated';
    if (currentId !== previousId) {
      submissions.reset();
    }
    previousId = currentId;
    previousEnd = state.session?.ends_at || null;
    previousStatus = state.session?.status || null;
    const roster = new Map(
      currentId && members.size
        ? sessionParticipants(currentId).map((member) => [member.credentialHash, member])
        : [],
    );
    for (const client of wss.clients) {
      if (!accessAllowed(client)) {
        client.close(1008, 'Sign in to view this site.');
        continue;
      }
      const token = members.get(client);
      const member = token ? roster.get(hashParticipantToken(token)) : undefined;
      send(client, {
        event,
        ...state,
        requiresPowerHourPassword,
        participant: member?.sessionId === currentId,
        scores:
          state.session?.report_mode ||
          isAdminCookieHeader(adminCookies.get(client)) ||
          member?.sessionId === currentId
            ? state.scores
            : [],
      });
    }
  };
  server.on('upgrade', (request, socket, head) => {
    try {
      if (new URL(request.url || '/', 'http://localhost').pathname !== '/ws') {
        // Astro development also handles Vite upgrades on this server.
        if (server.listenerCount('upgrade') === 1) socket.destroy();
        return;
      }
      const ip = realtimeClientIp(request);
      ensure(wss.clients.size < limits.maxConnections, 'Too many connections.');
      ensure((connectionsByIp.get(ip) || 0) < limits.maxConnectionsPerIp, 'Too many connections.');
      ensure(siteAccessAllowed(request.headers.cookie), 'Sign in to view this site.');
      const origin = request.headers.origin ? new URL(request.headers.origin) : null;
      ensure(
        origin &&
          ['http:', 'https:'].includes(origin.protocol) &&
          origin.origin === request.headers.origin &&
          origin.host === request.headers.host,
        'Invalid origin.',
      );
      wss.handleUpgrade(request, socket, head, (ws) => {
        connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);
        ws.once('close', () => {
          const count = (connectionsByIp.get(ip) || 1) - 1;
          if (count) connectionsByIp.set(ip, count);
          else connectionsByIp.delete(ip);
        });
        wss.emit('connection', ws, request);
      });
    } catch {
      socket.destroy();
    }
  });
  wss.on('connection', (client, request) => {
    alive.set(client, true);
    client.on('pong', () => alive.set(client, true));
    adminCookies.set(client, request.headers.cookie);
    if (isAdminCookieHeader(request.headers.cookie)) adminClients.add(client);
    const token = participantTokenFromCookie(request.headers.cookie);
    const initial = snapshot();
    const member = initial.session ? participantForToken(token, initial.session.id) : null;
    if (member && token) members.set(client, token);
    let messageWindow = Date.now(),
      messageCount = 0;
    let invalidWindow = Date.now(),
      invalidCount = 0;
    send(client, {
      event:
        initial.session?.status === 'ended'
          ? 'power_hour_ended'
          : initial.session
            ? 'power_hour_started'
            : 'state',
      ...initial,
      requiresPowerHourPassword: !initial.session?.report_mode && !getSitePrivacy().enabled,
      participant: !!member,
      scores:
        initial.session?.report_mode || isAdminCookieHeader(request.headers.cookie) || member
          ? initial.scores
          : [],
    });
    if (member) send(client, { event: 'joined', userId: member.userId, name: member.name });
    client.on('message', (raw) => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        if (!accessAllowed(client)) {
          client.close(1008, 'Sign in to view this site.');
          return;
        }
        if (Date.now() - messageWindow > 1000) {
          messageWindow = Date.now();
          messageCount = 0;
        }
        if (++messageCount > 30) {
          client.close(1008, 'Too many messages.');
          return;
        }
        const message = JSON.parse(raw.toString());
        ensure(message.action === 'increment', 'Unknown action.');
        const session = sessionState();
        ensure(session?.status === 'active', 'This Power Hour has ended.');
        ensure(!session.report_mode, 'Report-driven Power Hours are view-only.');
        const participant = participantForToken(token, session.id);
        ensure(participant, 'Join this Power Hour from this browser first.');
        // sessionId prevents stale buffered taps from landing in a newly started Power Hour.
        const sessionId = positiveId(message.sessionId);
        ensure(sessionId === session.id, 'This Power Hour has ended. Rejoin the current session.');
        ensure(participant.sessionId === sessionId, 'Join this Power Hour first.');
        submissions.submit(participant.userId, sessionId);
        broadcast();
      } catch (error) {
        if (Date.now() - invalidWindow > 10_000) {
          invalidWindow = Date.now();
          invalidCount = 0;
        }
        if (++invalidCount >= 5) {
          client.close(1008, 'Repeated invalid messages.');
          return;
        }
        send(client, {
          event: 'error',
          message: error instanceof Error ? error.message : 'Invalid message.',
        });
      }
    });
    client.on('error', () => {});
    client.on('close', () => {
      alive.delete(client);
      members.delete(client);
      adminCookies.delete(client);
      adminClients.delete(client);
    });
  });
  events.on('power-hour-change', broadcast);
  // Refresh public payloads too: a revoked admin must lose privileged scores.
  events.on('admin-session-change', broadcast);
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN || !alive.get(client)) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, limits.heartbeatMs);
  heartbeat.unref();
  // Reconciles expiry and any changes made by another SQLite connection.
  const timer = setInterval(() => {
    for (const client of wss.clients) {
      if (!accessAllowed(client)) client.close(1008, 'Sign in to view this site.');
    }
    const session = sessionState();
    if (
      (session?.id || null) !== previousId ||
      (session?.ends_at || null) !== previousEnd ||
      (session?.status || null) !== previousStatus ||
      !getSitePrivacy().enabled !== previousPasswordRequired
    )
      broadcast();
  }, 500);
  timer.unref();
  server.once('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    events.off('power-hour-change', broadcast);
    events.off('admin-session-change', broadcast);
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return wss;
}
