import './env.ts';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getProductionSqlite } from '../db/index.ts';
import { events } from './events.ts';
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const secret = () => process.env.ADMIN_PASSCODE || '';
const ADMIN_SESSION_MS = 12 * 3600000;
const examplePasscodes = new Set([
  'change-this-to-a-long-private-passcode',
  'browser-test-passcode',
  'site-access-admin-passcode',
  'power-hour-access-admin',
  'test-passcode',
]);
export function validProductionAdminPasscode(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    new Set(value.toLowerCase()).size >= 6 &&
    !/^(.{1,8})\1+$/i.test(value) &&
    !examplePasscodes.has(value.toLowerCase()) &&
    !/^(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example[-_ ]|password)/i.test(value)
  );
}
export function assertProductionAdminPasscode(): void {
  if (process.env.NODE_ENV === 'production' && !validProductionAdminPasscode(secret()))
    throw new Error(
      'Production ADMIN_PASSCODE must be a private passcode of 16 to 256 characters, without control characters, repeated patterns, or example values. Generate a random passcode before starting the server.',
    );
}
function configuredPasscode(): boolean {
  return (
    !!secret() && (process.env.NODE_ENV !== 'production' || validProductionAdminPasscode(secret()))
  );
}
function sessionCredential(): string {
  return createHmac('sha256', secret()).update('admin-session-credential-v1').digest('hex');
}
export function passcodeMatches(value: unknown): boolean {
  return configuredPasscode() && typeof value === 'string' && equal(value, secret());
}
export function cleanupAdminSessions(): void {
  getProductionSqlite()
    .prepare('DELETE FROM admin_sessions WHERE expires_at <= ? OR credential_hash != ?')
    .run(Date.now(), sessionCredential());
}
export function newSession(): string {
  if (!configuredPasscode()) throw new Error('ADMIN_PASSCODE has not been configured securely.');
  const token = randomBytes(32).toString('hex');
  const database = getProductionSqlite();
  database
    .transaction(() => {
      cleanupAdminSessions();
      // Bound storage even if successful logins originate from many addresses.
      database
        .prepare(
          'DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 999)',
        )
        .run();
      database
        .prepare(
          'INSERT INTO admin_sessions (token_hash, credential_hash, expires_at) VALUES (?, ?, ?)',
        )
        .run(hashParticipantToken(token), sessionCredential(), Date.now() + ADMIN_SESSION_MS);
    })
    .immediate();
  return token;
}
function validAdminSession(value: string): boolean {
  if (!configuredPasscode() || !validParticipantToken(value)) return false;
  const database = getProductionSqlite();
  const tokenHash = hashParticipantToken(value);
  const session = database
    .prepare('SELECT credential_hash, expires_at FROM admin_sessions WHERE token_hash = ?')
    .get(tokenHash) as { credential_hash: string; expires_at: number } | undefined;
  if (!session) return false;
  if (session.expires_at <= Date.now() || !equal(session.credential_hash, sessionCredential())) {
    database.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
    return false;
  }
  return true;
}
export function revokeAdminSession(value: string): void {
  if (!validParticipantToken(value)) return;
  getProductionSqlite()
    .prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
    .run(hashParticipantToken(value));
  events.emit('admin-session-change');
}
export function isAdmin(cookies: AstroCookies): boolean {
  return validAdminSession(cookies.get('admin')?.value || '');
}
export function isAdminCookieHeader(header: string | undefined): boolean {
  const value =
    header
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('admin='))
      ?.slice(6) || '';
  return validAdminSession(value);
}
export function validPowerHourPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    value.trim().length >= 8 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
export function hashPowerHourPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export function verifyPowerHourPassword(password: unknown, hash: string | null): boolean {
  if (!validPowerHourPassword(password) || !hash) return false;
  const [salt, digest] = hash.split(':');
  return !!salt && !!digest && equal(scryptSync(password, salt, 32).toString('hex'), digest);
}
export const PARTICIPANT_COOKIE = 'power_hour_participant';
export function newParticipantToken(): string {
  return randomBytes(32).toString('hex');
}
export function validParticipantToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function hashParticipantToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function participantTokenFromCookie(header: string | undefined): string | null {
  const value = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PARTICIPANT_COOKIE}=`))
    ?.slice(PARTICIPANT_COOKIE.length + 1);
  return validParticipantToken(value) ? value : null;
}
const attempts = new Map<string, { start: number; count: number }>();
export function allowAttempt(key: string, limit = 10): boolean {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.start > 600000) attempts.delete(k);
  const record = attempts.get(key) || { start: now, count: 0 };
  record.count++;
  attempts.set(key, record);
  return record.count <= limit;
}
export function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}
