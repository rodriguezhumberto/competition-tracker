import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { suggestPageBoundary } from '../src/lib/page-boundary.ts';
async function scene(contents: string, background = '#45413b') {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${background}"/>${contents}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}
const page = '<rect x="120" y="90" width="560" height="420" fill="#fff"/>';
const text =
  '<g font-size="18" font-family="Arial">' +
  Array.from(
    { length: 15 },
    (_, i) => `<text x="150" y="${125 + i * 24}">Operator ${100 + i} sales quantity 12.50</text>`,
  ).join('') +
  '</g>';

test('suggests the outer page with a margin and includes printed header and edge rows', async () => {
  const result = await suggestPageBoundary(await scene(page + text));
  assert.equal(result.status, 'suggested');
  assert(result.crop);
  const { x, y, width, height } = result.crop;
  assert(x <= 0.15 && y <= 0.15 && x + width >= 0.85 && y + height >= 0.85);
  assert(x >= 0.1 && y >= 0.1 && x + width <= 0.9 && y + height <= 0.9);
});

test('page coordinates follow manual rotation and EXIF correction', async () => {
  const source = await scene('<rect x="80" y="120" width="480" height="360" fill="#fff"/>');
  const original = await suggestPageBoundary(source);
  assert(original.crop);
  for (const rotation of [90, 180, 270] as const) {
    const result = await suggestPageBoundary(source, rotation);
    assert(result.crop);
    const a = original.crop,
      b = result.crop;
    const expected =
      rotation === 90
        ? [1 - a.y - a.height, a.x, a.height, a.width]
        : rotation === 180
          ? [1 - a.x - a.width, 1 - a.y - a.height, a.width, a.height]
          : [a.y, 1 - a.x - a.width, a.height, a.width];
    [b.x, b.y, b.width, b.height].forEach((v, i) => assert(Math.abs(v - expected[i]) < 0.01));
  }
  const exif = await sharp(source).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const corrected = await suggestPageBoundary(exif);
  const rotated = await suggestPageBoundary(source, 90);
  assert(corrected.crop && rotated.crop);
  assert(Math.abs(corrected.crop.x - rotated.crop.x) < 0.02);
});

test('retains the whole image for screenshots, clipped pages, multiple pages and low contrast', async () => {
  for (const source of [
    await scene(text, '#fff'),
    await scene('<rect x="0" y="90" width="680" height="420" fill="#fff"/>'),
    await scene(
      '<rect x="30" y="100" width="340" height="400" fill="#fff"/><rect x="430" y="100" width="340" height="400" fill="#fff"/>',
    ),
    await scene(page, '#dddddd'),
    await scene(''),
  ]) {
    const result = await suggestPageBoundary(source);
    assert.equal(result.status, 'none');
    assert.equal(result.crop, null);
  }
});

test('retains angled page corners inside the proposed bounding crop', async () => {
  const result = await suggestPageBoundary(
    await scene('<polygon points="180,80 700,160 620,520 100,440" fill="#fff"/>'),
  );
  assert(result.crop);
  assert(result.crop.x <= 100 / 800 && result.crop.y <= 80 / 600);
  assert(
    result.crop.x + result.crop.width >= 700 / 800 &&
      result.crop.y + result.crop.height >= 520 / 600,
  );
});

test('detects the outer sheet in grayscale uploads', async () => {
  const source = await sharp(await scene(page + text))
    .greyscale()
    .png()
    .toBuffer();
  assert.equal((await suggestPageBoundary(source)).status, 'suggested');
});

test('follows a shadowed receipt to its bottom while ignoring an unrelated clipped sheet', async () => {
  const width = 480,
    height = 640,
    pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const receipt = x >= 145 && x < 320 && y >= 20 && y < 580;
      const value = receipt
        ? 235 - Math.round(y * 0.13)
        : x >= 420
          ? 245
          : 80 + ((x * 73 + y * 37) % 90);
      pixels.fill(value, (y * width + x) * 3, (y * width + x + 1) * 3);
    }
  const result = await suggestPageBoundary(
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
  assert(result.crop);
  assert(result.crop.x <= 145 / width && result.crop.x + result.crop.width >= 320 / width);
  assert(result.crop.y <= 20 / height && result.crop.y + result.crop.height >= 580 / height);
  assert(result.crop.x + result.crop.width < 420 / width);
});
