const POSITION_KEY = 'power-hour-upload-position';

export function uploadPosition(root: HTMLElement): number {
  return Math.max(12, Math.min(root.getBoundingClientRect().top, innerHeight - 120));
}

export async function restoreUploadPosition(root: HTMLElement, top: number) {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  if (root.isConnected)
    window.scrollBy({ top: root.getBoundingClientRect().top - top, behavior: 'instant' });
}

export function saveUploadPosition(sessionId: number, top: number) {
  try {
    sessionStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ sessionId, top, expires: Date.now() + 30000 }),
    );
  } catch {}
}

export function takeUploadPosition(sessionId: number): number | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(POSITION_KEY) || 'null');
    if (!value || value.sessionId !== sessionId) return null;
    sessionStorage.removeItem(POSITION_KEY);
    return value.expires > Date.now() && Number.isFinite(value.top) ? value.top : null;
  } catch {
    return null;
  }
}
