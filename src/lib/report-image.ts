import { validateReportCrop, cropPixels, type ReportCrop } from './report-crop.ts';
import sharp from 'sharp';
import { ensure } from './validation.ts';

export type ReportRotation = number;
export function reportRotation(value: FormDataEntryValue | null): ReportRotation {
  ensure(
    value === null ||
      (typeof value === 'string' &&
        /^(?:0|[1-9]\d{0,2})(?:\.\d)?$/.test(value) &&
        Number(value) < 360),
    'Choose a rotation from 0 to less than 360 degrees.',
  );
  return Number(value || 0) as ReportRotation;
}

// Competition mappings describe report fields; this module only handles pixels.
export async function preprocessReportImage(
  bytes: Buffer,
  rotation: ReportRotation = 0,
  crop: ReportCrop | null = null,
) {
  ensure(Number.isFinite(rotation) && rotation >= 0 && rotation < 360, 'Invalid report rotation.');
  const selectedCrop = crop === null ? null : validateReportCrop(crop);
  try {
    const input = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const source = await input.metadata();
    ensure(!source.pages || source.pages === 1, 'Choose a single, non-animated report image.');
    // Use separate pipelines so EXIF correction always precedes manual rotation.
    const oriented = await input.autoOrient().flatten({ background: '#fff' }).png().toBuffer();
    const rotated = await sharp(oriented)
      .rotate(rotation, { background: '#fff' })
      .png()
      .toBuffer({ resolveWithObject: true });
    const pixelCrop = selectedCrop
      ? cropPixels(selectedCrop, rotated.info.width, rotated.info.height)
      : null;
    const { data, info } = pixelCrop
      ? await sharp(rotated.data).extract(pixelCrop).png().toBuffer({ resolveWithObject: true })
      : rotated;
    return {
      bytes: data,
      mimeType: 'image/png',
      processing: {
        version: 2,
        crop: selectedCrop,
        crop_pixels: pixelCrop,
        rotated_width: rotated.info.width,
        rotated_height: rotated.info.height,
        exif_orientation: source.orientation || 1,
        rotation,
        width: info.width,
        height: info.height,
        format: 'png',
      },
    };
  } catch (error) {
    throw new Error(
      'Unable to decode this report image. Choose a valid PNG, JPEG or WebP under 40 megapixels.',
      { cause: error },
    );
  }
}

export function reportImageArtifacts(filename: string) {
  return { processed: `${filename}.processed.png`, metadata: `${filename}.processing.json` };
}
