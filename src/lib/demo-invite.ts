/** The build's public site is canonical; local builds retain the request's port. */
export function demoInviteUrl(
  requestUrl: URL,
  workspaceId: string,
  shareToken: string,
  publicOrigin: string | undefined = import.meta.env?.SITE,
): string {
  const invite = new URL('/demo', publicOrigin || requestUrl.origin);
  invite.searchParams.set('room', workspaceId);
  invite.searchParams.set('invite', shareToken);
  return invite.toString();
}
