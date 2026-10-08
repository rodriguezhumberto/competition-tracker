import { adaptiveOrientationImage } from './orientation-image.ts';
import { suggestNormalizedPageBoundary } from './page-boundary.ts';
import { cropPixels } from './report-crop.ts';
import './env.ts';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { preprocessReportImage, type ReportRotation } from './report-image.ts';

// Tesseract's orientation confidence is a margin, not a percentage.
// Its API documents 15 as reasonably confident; weaker readings require review.
export const ORIENTATION_CONFIDENCE_THRESHOLD = 15;
export interface ReportOrientation {
  status: 'confident' | 'uncertain' | 'unavailable';
  rotation: ReportRotation | null;
  confidence: number | null;
  reason:
    | 'detected'
    | 'low_confidence'
    | 'insufficient_text'
    | 'unavailable'
    | 'timeout'
    | 'invalid_result';
}
export const unknownOrientation = (reason: ReportOrientation['reason']): ReportOrientation => ({
  status: reason === 'unavailable' || reason === 'timeout' ? 'unavailable' : 'uncertain',
  rotation: null,
  confidence: null,
  reason,
});
export function parseOrientation(output: string): ReportOrientation {
  const rotation = output.match(/^Rotate:\s*(0|90|180|270)\s*$/m);
  const confidence = output.match(/^Orientation confidence:\s*(\d+(?:\.\d+)?)\s*$/m);
  if (!rotation || !confidence || !Number.isFinite(Number(confidence[1])))
    return unknownOrientation('invalid_result');
  const score = Number(confidence[1]);
  return {
    status: score >= ORIENTATION_CONFIDENCE_THRESHOLD ? 'confident' : 'uncertain',
    rotation: Number(rotation[1]) as ReportRotation,
    confidence: score,
    reason: score >= ORIENTATION_CONFIDENCE_THRESHOLD ? 'detected' : 'low_confidence',
  };
}

// Conflicting useful readings stay suggestions, never automatic rotations.
export function selectOrientation(readings: ReportOrientation[]): ReportOrientation {
  const useful = readings
    .filter((r) => r.rotation !== null && r.confidence !== null)
    .sort((a, b) => b.confidence! - a.confidence!);
  if (!useful.length) return readings[0] || unknownOrientation('insufficient_text');
  const best = useful[0];
  if (useful.some((r) => r.rotation !== best.rotation && r.confidence! >= 8))
    return { ...best, status: 'uncertain', reason: 'low_confidence' };
  return best;
}

async function readOrientation(
  sample: Buffer,
  timeout: number,
  signal?: AbortSignal,
): Promise<ReportOrientation> {
  if (timeout <= 0 || signal?.aborted) return unknownOrientation('timeout');
  return new Promise((resolve) => {
    const child = execFile(
      process.env.TESSERACT_PATH || 'tesseract',
      ['stdin', 'stdout', '--psm', '0', '-l', 'osd', '--dpi', '300'],
      {
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024,
        signal,
        env: { ...process.env, OMP_THREAD_LIMIT: '1', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(parseOrientation(stdout));
          return;
        }
        if (
          error.code === 'ENOENT' ||
          /Error opening data file|Failed loading language/i.test(stderr)
        )
          resolve(unknownOrientation('unavailable'));
        else if (error.killed) resolve(unknownOrientation('timeout'));
        else if (/Too few characters|Skipping this page/i.test(stderr))
          resolve(unknownOrientation('insufficient_text'));
        else resolve(unknownOrientation('invalid_result'));
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(sample);
  });
}

export async function detectReportOrientation(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<ReportOrientation> {
  const deadline = Date.now() + 15_000;
  const normalized = await preprocessReportImage(bytes);
  const sample = await sharp(normalized.bytes)
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const remaining = () => Math.max(0, Math.min(6000, deadline - Date.now()));
  const readings = [await readOrientation(sample, remaining(), signal)];
  if (readings[0].status === 'confident' || readings[0].status === 'unavailable' || signal?.aborted)
    return readings[0];
  if (remaining())
    readings.push(
      await readOrientation(await adaptiveOrientationImage(sample), remaining(), signal),
    );
  if (selectOrientation(readings).status === 'confident' || signal?.aborted || !remaining())
    return selectOrientation(readings);
  const boundary = await suggestNormalizedPageBoundary(normalized.bytes);
  if (boundary.crop && remaining() && !signal?.aborted) {
    const box = cropPixels(
      boundary.crop,
      normalized.processing.width,
      normalized.processing.height,
    );
    const region = await sharp(normalized.bytes)
      .extract(box)
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const original = await readOrientation(region, remaining(), signal);
    readings.push(original);
    if (selectOrientation(readings).status !== 'confident' && remaining() && !signal?.aborted)
      readings.push(
        await readOrientation(await adaptiveOrientationImage(region), remaining(), signal),
      );
  }
  return selectOrientation(readings);
}
