import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { preprocessReportImage, reportRotation } from '../src/lib/report-image.ts';

const colors = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
];
async function fixture(orientation = 1) {
  return sharp(Buffer.from(colors.flat()), { raw: { width: 3, height: 2, channels: 3 } })
    .withMetadata({ orientation })
    .png()
    .toBuffer();
}
async function pixels(bytes: Buffer) {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    order: Array.from({ length: info.width * info.height }, (_, i) =>
      colors.findIndex((c) => c.every((v, j) => v === data[i * 3 + j])),
    ),
  };
}

test('normalizes all eight EXIF orientations, including mirrored images, without losing pixels', async () => {
  const expected = [
    [0, 1, 2, 3, 4, 5],
    [2, 1, 0, 5, 4, 3],
    [5, 4, 3, 2, 1, 0],
    [3, 4, 5, 0, 1, 2],
    [0, 3, 1, 4, 2, 5],
    [3, 0, 4, 1, 5, 2],
    [5, 2, 4, 1, 3, 0],
    [2, 5, 1, 4, 0, 3],
  ];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const original = await fixture(orientation),
      before = Buffer.from(original);
    const result = await preprocessReportImage(original);
    assert.deepEqual(await pixels(result.bytes), {
      width: orientation >= 5 ? 2 : 3,
      height: orientation >= 5 ? 3 : 2,
      order: expected[orientation - 1],
    });
    assert.deepEqual(original, before);
    assert.equal(result.processing.exif_orientation, orientation);
    assert.equal((await sharp(result.bytes).metadata()).orientation, undefined);
  }
});

test('manual rotation follows EXIF correction, preserves pixel details and records dimensions', async () => {
  const source = await fixture(6);
  for (const [rotation, order] of [
    [0, [3, 0, 4, 1, 5, 2]],
    [90, [5, 4, 3, 2, 1, 0]],
    [180, [2, 5, 1, 4, 0, 3]],
    [270, [0, 1, 2, 3, 4, 5]],
  ] as const) {
    const result = await preprocessReportImage(source, rotation);
    const decoded = await pixels(result.bytes);
    assert.deepEqual(decoded.order, order);
    assert.equal(result.processing.width, decoded.width);
    assert.equal(result.processing.height, decoded.height);
    assert.equal(result.processing.rotation, rotation);
  }
});

test('flattens transparent pixels onto white and accepts JPEG and WebP', async () => {
  const transparent = await sharp({
    create: { width: 2, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const { bytes } = await preprocessReportImage(transparent);
  assert.deepEqual([...(await sharp(bytes).raw().toBuffer())], [255, 255, 255, 255, 255, 255]);
  for (const format of ['jpeg', 'webp'] as const) {
    const result = await preprocessReportImage(
      await sharp(await fixture())
        .toFormat(format)
        .toBuffer(),
      90,
    );
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.processing.width, 2);
    assert.equal(result.processing.height, 3);
  }
});

test('rejects invalid rotations, corrupt images and oversized decoded images', async () => {
  assert.equal(reportRotation(null), 0);
  for (const rotation of ['0', '12.5', '90', '180', '270', '359.9'])
    assert.equal(reportRotation(rotation), Number(rotation));
  for (const rotation of ['', '-90', '360', 'NaN', '12.55', 'banana', new File(['x'], 'x')])
    assert.throws(() => reportRotation(rotation));
  await assert.rejects(preprocessReportImage(Buffer.from('not an image')), /Unable to decode/);
  const oversized = await sharp({
    create: { width: 6400, height: 6400, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  await assert.rejects(preprocessReportImage(oversized), /40 megapixels/);
});

test('crops the final upright pixels after every EXIF orientation and manual rotation', async () => {
  const layouts = [
    [0, 1, 2, 3, 4, 5],
    [2, 1, 0, 5, 4, 3],
    [5, 4, 3, 2, 1, 0],
    [3, 4, 5, 0, 1, 2],
    [0, 3, 1, 4, 2, 5],
    [3, 0, 4, 1, 5, 2],
    [5, 2, 4, 1, 3, 0],
    [2, 5, 1, 4, 0, 3],
  ];
  for (let orientation = 1; orientation <= 8; orientation++) {
    for (const rotation of [0, 90, 180, 270] as const) {
      let width = orientation >= 5 ? 2 : 3,
        height = orientation >= 5 ? 3 : 2;
      let order = layouts[orientation - 1];
      for (let turn = 0; turn < rotation / 90; turn++) {
        const next = Array.from(
          { length: width * height },
          (_, i) => order[(height - 1 - (i % height)) * width + Math.floor(i / height)],
        );
        [width, height] = [height, width];
        order = next;
      }
      const crop = { x: 1 / width, y: 0, width: 1 / width, height: 1 / height };
      const source = await fixture(orientation),
        original = Buffer.from(source);
      const result = await preprocessReportImage(source, rotation, crop);
      assert.deepEqual(
        await pixels(result.bytes),
        { width: 1, height: 1, order: [order[1]] },
        `${orientation}, ${rotation}`,
      );
      assert.deepEqual(source, original);
      assert.deepEqual(result.processing.crop_pixels, { left: 1, top: 0, width: 1, height: 1 });
      assert.equal(result.processing.rotated_width, width);
      assert.equal(result.processing.rotated_height, height);
    }
  }
});

test('fine rotation fills exposed corners with white and crops after straightening', async () => {
  const source = await sharp({
    create: { width: 200, height: 100, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  for (const rotation of [12.5, 102.5, 347.5]) {
    const full = await preprocessReportImage(source, rotation);
    const expected = await sharp(source).rotate(rotation, { background: '#fff' }).png().toBuffer();
    assert.deepEqual(full.bytes, expected);
    const raw = await sharp(full.bytes).removeAlpha().raw().toBuffer();
    assert.deepEqual([...raw.subarray(0, 3)], [255, 255, 255]);
    const cropped = await preprocessReportImage(source, rotation, {
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
    assert.deepEqual(
      cropped.bytes,
      await sharp(expected).extract(cropped.processing.crop_pixels!).png().toBuffer(),
    );
  }
});
