import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getProductionSqlite } from '../db/index.ts';
import {
  hashPowerHourPassword,
  verifyPowerHourPassword,
  validPowerHourPassword,
  isAdminCookieHeader,
} from './auth.ts';

export const VIEWER_COOKIE = 'site_viewer';
export const VIEWER_SESSION_SECONDS = 12 * 3600;

export function getSitePrivacy() {
  const row = getProductionSqlite().prepare('SELECT * FROM site_privacy WHERE id = 1').get() as
    { enabled: number; password_hash: string | null; session_version: string } | undefined;
  if (!row) throw new Error('Site privacy settings are missing. Run database migrations.');
  return {
    enabled: !!row.enabled,
    passwordHash: row.password_hash,
    sessionVersion: row.session_version,
  };
}

export function updateSitePrivacy(enabled: boolean, password?: string): void {
  const database = getProductionSqlite();
  database
    .transaction(() => {
      const current = getSitePrivacy();
      if (password && !validPowerHourPassword(password))
        throw new Error('Choose a password with 8 to 128 characters.');
      const passwordHash = password ? hashPowerHourPassword(password) : current.passwordHash;
      if (enabled && !passwordHash)
        throw new Error('Set a password before enabling site protection.');
      const version =
        enabled !== current.enabled || password
          ? randomBytes(32).toString('hex')
          : current.sessionVersion;
      database
        .prepare(
          'UPDATE site_privacy SET enabled = ?, password_hash = ?, session_version = ? WHERE id = 1',
        )
        .run(Number(enabled), passwordHash, version);
    })
    .immediate();
}

export function revokeViewerSessions(): void {
  getProductionSqlite()
    .prepare('UPDATE site_privacy SET session_version = ? WHERE id = 1')
    .run(randomBytes(32).toString('hex'));
}

export function viewerPasswordMatches(value: unknown): boolean {
  const settings = getSitePrivacy();
  return settings.enabled && verifyPowerHourPassword(value, settings.passwordHash);
}

function signature(value: string, settings: ReturnType<typeof getSitePrivacy>): string {
  return createHmac('sha256', settings.passwordHash || '')
    .update(`site-viewer:${value}`)
    .digest('hex');
}

export function newViewerSession(): string {
  const settings = getSitePrivacy();
  if (!settings.enabled || !settings.passwordHash) throw new Error('Site protection is disabled.');
  const value = `${Date.now() + VIEWER_SESSION_SECONDS * 1000}.${settings.sessionVersion}.${randomBytes(16).toString('hex')}`;
  return `${value}.${signature(value, settings)}`;
}

export function validViewerSession(token: string): boolean {
  const settings = getSitePrivacy();
  if (!settings.enabled || !settings.passwordHash) return false;
  const [expires, version, nonce, digest, extra] = token.split('.');
  if (
    extra !== undefined ||
    !/^\d+$/.test(expires || '') ||
    Number(expires) <= Date.now() ||
    version !== settings.sessionVersion ||
    !/^[a-f0-9]{32}$/.test(nonce || '') ||
    !/^[a-f0-9]{64}$/.test(digest || '')
  )
    return false;
  const expected = signature(`${expires}.${version}.${nonce}`, settings);
  return timingSafeEqual(Buffer.from(digest), Buffer.from(expected));
}

export function isViewerCookieHeader(header: string | undefined): boolean {
  const token =
    header
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${VIEWER_COOKIE}=`))
      ?.slice(VIEWER_COOKIE.length + 1) || '';
  return validViewerSession(token);
}

export function siteAccessAllowed(header: string | undefined): boolean {
  return !getSitePrivacy().enabled || isAdminCookieHeader(header) || isViewerCookieHeader(header);
}

export function isDemoSitePath(path: string): boolean {
  return (
    path === '/demo' ||
    path.startsWith('/demo/') ||
    ['/api/demo', '/api/demo/competition', '/api/demo/activate'].includes(path)
  );
}

export function isPublicSitePath(path: string): boolean {
  return (
    isDemoSitePath(path) ||
    [
      '/login',
      '/api/site-logout',
      '/admin/login',
      '/favicon-blue.svg',
      '/disclaimer',
      '/privacy',
    ].includes(path) ||
    path.startsWith('/_astro/')
  );
}

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value))
    return '/';
  try {
    const url = new URL(value, 'http://site.local');
    if (
      url.origin !== 'http://site.local' ||
      url.pathname === '/login' ||
      url.pathname.startsWith('/api/')
    )
      return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}
