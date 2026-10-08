import test from 'node:test';
import assert from 'node:assert/strict';
import { cropPixels, reportCrop, validateReportCrop } from '../src/lib/report-crop.ts';

test('rejects malformed, non-finite, empty and out-of-bounds crops', () => {
  assert.equal(reportCrop(null), null);
  for (const value of ['', 'null', '[]', '{}', 'bad json', new File(['x'], 'crop')])
    assert.throws(() => reportCrop(value));
  for (const value of [
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1, height: -1 },
    { x: 0.5, y: 0.5, width: 0.6, height: 0.5 },
    { x: 1, y: 0, width: 0.1, height: 1 },
    { x: 0, y: Infinity, width: 0.5, height: 0.5 },
    { x: NaN, y: 0, width: 0.5, height: 0.5 },
    { x: '0', y: 0, width: 1, height: 1 },
  ])
    assert.throws(() => validateReportCrop(value));
  assert.deepEqual(reportCrop('{"x":0.1,"y":0.2,"width":0.6,"height":0.5}'), {
    x: 0.1,
    y: 0.2,
    width: 0.6,
    height: 0.5,
  });
});

test('normalized crop retains edge pixels and remains accurate at original resolution', () => {
  const crop = { x: 0.123, y: 0.25, width: 0.5, height: 0.5 };
  assert.deepEqual(cropPixels(crop, 100, 80), { left: 12, top: 20, width: 51, height: 40 });
  assert.deepEqual(cropPixels(crop, 4000, 3000), {
    left: 492,
    top: 750,
    width: 2000,
    height: 1500,
  });
  assert.deepEqual(cropPixels({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 11, 11), {
    left: 9,
    top: 9,
    width: 2,
    height: 2,
  });
});
