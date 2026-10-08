import type { ReportCrop } from './report-crop.ts';

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const minimumSize = 0.02;

export function adjustCropField(
  origin: ReportCrop,
  field: keyof ReportCrop,
  percent: number,
): ReportCrop {
  if (!Number.isFinite(percent)) return origin;
  const next = { ...origin };
  const value = percent / 100;
  if (field === 'x' || field === 'y') {
    next[field] = clamp(value, 0, 1 - next[field === 'x' ? 'width' : 'height']);
  } else {
    next[field] = clamp(value, minimumSize, 1 - next[field === 'width' ? 'x' : 'y']);
  }
  return next;
}

export function moveCrop(origin: ReportCrop, mode: string, dx: number, dy: number): ReportCrop {
  if (mode === 'move') {
    return {
      ...origin,
      x: clamp(origin.x + dx, 0, 1 - origin.width),
      y: clamp(origin.y + dy, 0, 1 - origin.height),
    };
  }
  let left = origin.x,
    top = origin.y;
  let right = left + origin.width,
    bottom = top + origin.height;
  if (mode.includes('w')) left = clamp(left + dx, 0, right - minimumSize);
  if (mode.includes('e')) right = clamp(right + dx, left + minimumSize, 1);
  if (mode.includes('n')) top = clamp(top + dy, 0, bottom - minimumSize);
  if (mode.includes('s')) bottom = clamp(bottom + dy, top + minimumSize, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
