export interface ReportCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const fullReportCrop = (): ReportCrop => ({ x: 0, y: 0, width: 1, height: 1 });
export function validateReportCrop(value: unknown): ReportCrop {
  const fail = () => {
    throw new Error('Choose a non-empty crop within the report image.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const crop = value as ReportCrop;
  if (
    !['x', 'y', 'width', 'height'].every(
      (key) =>
        typeof crop[key as keyof ReportCrop] === 'number' &&
        Number.isFinite(crop[key as keyof ReportCrop]),
    )
  )
    return fail();
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x >= 1 ||
    crop.y >= 1 ||
    crop.x + crop.width > 1 + 1e-9 ||
    crop.y + crop.height > 1 + 1e-9
  )
    return fail();
  return {
    x: crop.x,
    y: crop.y,
    width: Math.min(crop.width, 1 - crop.x),
    height: Math.min(crop.height, 1 - crop.y),
  };
}
export function reportCrop(value: FormDataEntryValue | null): ReportCrop | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 500) throw new Error('Invalid report crop.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error('Invalid report crop.');
  }
  return validateReportCrop(decoded);
}
// Round outward so selected edge pixels are retained. Both preview and server use this.
export function cropPixels(crop: ReportCrop, width: number, height: number) {
  const valid = validateReportCrop(crop);
  const left = Math.floor(valid.x * width),
    top = Math.floor(valid.y * height);
  const right = Math.min(width, Math.ceil((valid.x + valid.width) * width));
  const bottom = Math.min(height, Math.ceil((valid.y + valid.height) * height));
  return { left, top, width: right - left, height: bottom - top };
}
