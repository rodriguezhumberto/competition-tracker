import { localImageStats } from './image-local-stats.ts';
import sharp from 'sharp';
import { preprocessReportImage, type ReportRotation } from './report-image.ts';
import type { ReportCrop } from './report-crop.ts';

export interface PageBoundary {
  status: 'suggested' | 'none';
  crop: ReportCrop | null;
  reason: 'page_found' | 'already_framed' | 'uncertain';
}
const none = (reason: 'already_framed' | 'uncertain'): PageBoundary => ({
  status: 'none',
  crop: null,
  reason,
});
const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] || 0;
};

// Detect paper, not text/table boundaries. Ambiguous scenes retain the whole image.
export async function suggestPageBoundary(
  bytes: Buffer,
  rotation: ReportRotation = 0,
): Promise<PageBoundary> {
  const normalized = await preprocessReportImage(bytes, rotation);
  return suggestNormalizedPageBoundary(normalized.bytes);
}

// Accept EXIF-normalized pixels so orientation retries can reuse their decoded image.
export async function suggestNormalizedPageBoundary(bytes: Buffer): Promise<PageBoundary> {
  const { data, info } = await sharp(bytes)
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info,
    size = width * height;
  if (width < 40 || height < 40) return none('uncertain');
  const luminance = new Uint8Array(size),
    chroma = new Uint8Array(size),
    border: number[] = [];
  for (let i = 0; i < size; i++) {
    const r = data[i * channels],
      g = data[i * channels + 1],
      b = data[i * channels + 2];
    luminance[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
    const x = i % width,
      y = Math.floor(i / width);
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) border.push(luminance[i]);
  }
  const background = median(border);
  // A light frame gives no reliable evidence of paper against a distinct background.
  if (background >= 215) return none('already_framed');
  const threshold = Math.max(185, background + 35);
  type Candidate = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    count: number;
    brightness: number;
  };
  function candidatesFor(shadows: boolean): Candidate[] {
    const texture = shadows ? localImageStats(luminance, width, height, 3, true).deviation! : null;
    const floor = shadows ? Math.max(95, background * 0.7) : threshold;
    const allowed = (i: number) =>
      luminance[i] >= floor && chroma[i] <= 45 && (!texture || texture[i] <= 14);
    const visited = new Uint8Array(size),
      queue = new Int32Array(size),
      candidates: Candidate[] = [];
    for (let seed = 0; seed < size; seed++) {
      // Shadow growth must begin on bright paper, not an arbitrary smooth object.
      if (visited[seed] || luminance[seed] < threshold || !allowed(seed)) continue;
      let head = 0,
        tail = 1,
        count = 0,
        brightness = 0;
      queue[0] = seed;
      visited[seed] = 1;
      let left = width,
        top = height,
        right = 0,
        bottom = 0;
      while (head < tail) {
        const pixel = queue[head++],
          x = pixel % width,
          y = Math.floor(pixel / width);
        count++;
        brightness += luminance[pixel];
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (const next of [
          x > 0 ? pixel - 1 : -1,
          x < width - 1 ? pixel + 1 : -1,
          pixel - width,
          pixel + width,
        ]) {
          if (next >= 0 && next < size && !visited[next] && allowed(next)) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
      const w = right - left + 1,
        h = bottom - top + 1;
      // Ignore unrelated clipped sheets before ranking complete page candidates.
      if (left < 3 || top < 3 || right >= width - 3 || bottom >= height - 3) continue;
      if (
        count >= size * 0.15 &&
        w >= width * 0.3 &&
        h >= height * 0.3 &&
        count / (w * h) >= (shadows ? 0.55 : 0.68) &&
        w / h >= 0.2 &&
        w / h <= 5
      )
        candidates.push({ left, top, right, bottom, count, brightness: brightness / count });
    }
    return candidates.sort((a, b) => b.count - a.count);
  }
  const brightCandidates = candidatesFor(false);
  const shadowCandidates = candidatesFor(true);
  // Preserve ambiguity checks. For a shared page, take the union so shadows cannot
  // silently truncate a crop that also has a plausible bright-only component.
  if (
    [brightCandidates, shadowCandidates].some(
      (list) => list[1] && list[1].count >= list[0].count * 0.3,
    )
  )
    return none('uncertain');
  let page = shadowCandidates[0] || brightCandidates[0];
  if (!page) return none('uncertain');
  const bright = brightCandidates[0];
  if (bright && shadowCandidates[0]) {
    const intersection =
      Math.max(0, Math.min(page.right, bright.right) - Math.max(page.left, bright.left) + 1) *
      Math.max(0, Math.min(page.bottom, bright.bottom) - Math.max(page.top, bright.top) + 1);
    const smaller = Math.min(
      (page.right - page.left + 1) * (page.bottom - page.top + 1),
      (bright.right - bright.left + 1) * (bright.bottom - bright.top + 1),
    );
    if (intersection < smaller * 0.7) return none('uncertain');
    page = {
      ...page,
      left: Math.min(page.left, bright.left),
      top: Math.min(page.top, bright.top),
      right: Math.max(page.right, bright.right),
      bottom: Math.max(page.bottom, bright.bottom),
    };
  }
  const outside: number[] = [];
  for (let y = 0; y < height; y += 2)
    for (let x = 0; x < width; x += 2) {
      if (x < page.left || x > page.right || y < page.top || y > page.bottom)
        outside.push(luminance[y * width + x]);
    }
  if (page.brightness - median(outside) < 35) return none('uncertain');
  const margin = Math.max(3, Math.ceil(Math.min(width, height) * 0.025));
  const left = Math.max(0, page.left - margin),
    top = Math.max(0, page.top - margin);
  const right = Math.min(width, page.right + 1 + margin),
    bottom = Math.min(height, page.bottom + 1 + margin);
  if ((right - left) * (bottom - top) >= size * 0.95) return none('already_framed');
  return {
    status: 'suggested',
    reason: 'page_found',
    crop: {
      x: left / width,
      y: top / height,
      width: (right - left) / width,
      height: (bottom - top) / height,
    },
  };
}
