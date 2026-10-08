import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  detectReportOrientation,
  parseOrientation,
  selectOrientation,
} from '../src/lib/report-orientation.ts';
import { adaptiveOrientationImage } from '../src/lib/orientation-image.ts';
import { preprocessReportImage } from '../src/lib/report-image.ts';
const directory = await mkdtemp(join(tmpdir(), 'report-orientation-'));
after(() => rm(directory, { recursive: true, force: true }));

const output = (rotation: number, confidence: number) =>
  `Page number: 0\nOrientation in degrees: ${(360 - rotation) % 360}\nRotate: ${rotation}\nOrientation confidence: ${confidence}\nScript: Latin\n`;
test('uses corrective rotation, not observed orientation, and requires confidence of at least 15', () => {
  for (const rotation of [0, 90, 180, 270]) {
    assert.equal(parseOrientation(output(rotation, 15)).rotation, rotation);
    assert.equal(parseOrientation(output(rotation, 15)).status, 'confident');
    assert.equal(parseOrientation(output(rotation, 14.99)).status, 'uncertain');
  }
  for (const value of ['', output(45, 20), output(90, NaN), output(90, -1), output(90, Infinity)]) {
    assert.equal(parseOrientation(value).rotation, null);
    assert.equal(parseOrientation(value).status, 'uncertain');
  }
});

test('sends EXIF-normalized pixels to local OCR and handles missing engines and sparse text', async () => {
  const savedPath = process.env.TESSERACT_PATH;
  const savedHash = process.env.ORIENTATION_TEST_HASH;
  try {
    const source = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#fff' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const normalized = await preprocessReportImage(source);
    process.env.ORIENTATION_TEST_HASH = createHash('sha256').update(normalized.bytes).digest('hex');
    const executable = join(directory, 'ocr.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport {createHash} from 'node:crypto';\nlet bytes=[]; for await (const chunk of process.stdin) bytes.push(chunk);\nif(createHash('sha256').update(Buffer.concat(bytes)).digest('hex') !== process.env.ORIENTATION_TEST_HASH) process.exit(2);\nif(JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['stdin','stdout','--psm','0','-l','osd','--dpi','300'])) process.exit(3);\nconsole.log(${JSON.stringify(output(270, 19))});\n`,
      { mode: 0o700 },
    );
    process.env.TESSERACT_PATH = executable;
    assert.deepEqual(await detectReportOrientation(source), {
      status: 'confident',
      rotation: 270,
      confidence: 19,
      reason: 'detected',
    });
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stderr.write("Too few characters. Skipping this page"); process.exit(1);\n',
      { mode: 0o700 },
    );
    assert.equal((await detectReportOrientation(source)).reason, 'insufficient_text');
    process.env.TESSERACT_PATH = join(directory, 'missing');
    assert.equal((await detectReportOrientation(source)).status, 'unavailable');
  } finally {
    if (savedPath === undefined) delete process.env.TESSERACT_PATH;
    else process.env.TESSERACT_PATH = savedPath;
    if (savedHash === undefined) delete process.env.ORIENTATION_TEST_HASH;
    else process.env.ORIENTATION_TEST_HASH = savedHash;
  }
});

const native = spawnSync(process.env.TESSERACT_PATH || 'tesseract', ['--list-langs'], {
  encoding: 'utf8',
});
const hasOsd = native.status === 0 && /\bosd\b/.test(native.stdout + native.stderr);
test('conflicting useful orientation readings require review', () => {
  assert.equal(
    selectOrientation([parseOrientation(output(90, 18)), parseOrientation(output(0, 9))]).status,
    'uncertain',
  );
  assert.equal(
    selectOrientation([parseOrientation(output(90, 18)), parseOrientation(output(0, 2))]).status,
    'confident',
  );
});

test('adaptive threshold retains dark text across uneven illumination without changing the source', async () => {
  const width = 200,
    height = 120,
    pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels[y * width + x] =
        x % 40 >= 15 && x % 40 < 19 && y >= 30 && y < 90 ? 30 : 240 - Math.round(x * 0.5);
  const source = await sharp(pixels, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const original = Buffer.from(source);
  const binary = await sharp(await adaptiveOrientationImage(source))
    .greyscale()
    .raw()
    .toBuffer();
  assert.deepEqual(source, original);
  assert(binary.every((value) => value === 0 || value === 255));
  for (const x of [16, 176]) assert.equal(binary[60 * width + x], 0);
  for (const x of [5, 195]) assert.equal(binary[60 * width + x], 255);
});

test('orientation retries a bounded page region after whole-image readings fail', async () => {
  const savedPath = process.env.TESSERACT_PATH;
  try {
    const source = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#45413b"/><rect x="120" y="90" width="560" height="420" fill="white"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const executable = join(directory, 'region-ocr.mjs');
    const sharpUrl = import.meta.resolve('sharp');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport sharp from ${JSON.stringify(sharpUrl)};\nlet bytes=[]; for await(const chunk of process.stdin) bytes.push(chunk);\nconst {width}=await sharp(Buffer.concat(bytes)).metadata();\nif(width>=800){process.stderr.write('Too few characters'); process.exit(1);}\nconsole.log(${JSON.stringify(output(90, 18))});\n`,
      { mode: 0o700 },
    );
    process.env.TESSERACT_PATH = executable;
    assert.deepEqual(await detectReportOrientation(source), {
      status: 'confident',
      rotation: 90,
      confidence: 18,
      reason: 'detected',
    });
  } finally {
    if (savedPath === undefined) delete process.env.TESSERACT_PATH;
    else process.env.TESSERACT_PATH = savedPath;
  }
});

test(
  'real local OCR detects all four rotations across different report layouts',
  { skip: !hasOsd },
  async () => {
    for (const layout of ['cashier', 'activity']) {
      const lines =
        layout === 'cashier'
          ? [
              'Generated October 02 2026 08:00 AM',
              'Cashier Sales Summary Report',
              'Operator Number       Sales Quantity       Total Revenue',
              ...Array.from(
                { length: 24 },
                (_, i) =>
                  `Cashier operator ${100 + i} recorded daily sales quantity ${(i + 1) * 12}.50 dollars`,
              ),
              'End of report: verify all participant values before saving',
            ]
          : [
              'Employee Activity Report',
              'Report period October 01 through October 02 2026',
              'Employee Identifier       Completed Calls       Appointments',
              ...Array.from(
                { length: 24 },
                (_, i) =>
                  `Employee member ${200 + i} completed twenty calls and scheduled appointments`,
              ),
              'Generated October 02 2026 at eight in the morning',
            ];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1300"><rect width="100%" height="100%" fill="white"/><g font-family="Arial" font-size="28">${lines.map((line, i) => `<text x="40" y="${55 + i * 42}">${line}</text>`).join('')}</g></svg>`;
      const upright = await sharp(Buffer.from(svg)).png().toBuffer();
      for (const rotation of [0, 90, 180, 270]) {
        const result = await detectReportOrientation(
          await sharp(upright).rotate(rotation).png().toBuffer(),
        );
        assert.equal(
          result.rotation,
          (360 - rotation) % 360,
          `${layout}, ${rotation}: ${JSON.stringify(result)}`,
        );
        assert.notEqual(result.status, 'unavailable');
      }
    }
  },
);
