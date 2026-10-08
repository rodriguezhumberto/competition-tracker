import { ensure } from './validation.ts';
export async function readReportImage(file: FormDataEntryValue | null) {
  ensure(
    file instanceof File && file.size > 0 && file.size <= 5 * 1024 * 1024,
    'Choose an image under 5 MB.',
  );
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? ['image/png', 'png']
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? ['image/jpeg', 'jpg']
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? ['image/webp', 'webp']
        : null;
  ensure(type, 'Only PNG, JPEG, and WebP report images are supported.');
  return { bytes, mimeType: type[0], extension: type[1] };
}
