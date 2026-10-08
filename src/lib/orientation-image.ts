import sharp from 'sharp';
import { localImageStats } from './image-local-stats.ts';

// Detection only: preserve the source and the pixels used for extraction.
export async function adaptiveOrientationImage(bytes: Buffer) {
  const { data, info } = await sharp(bytes)
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { mean } = localImageStats(data, info.width, info.height, 30);
  const binary = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) binary[i] = data[i] < mean[i] - 12 ? 0 : 255;
  return sharp(binary, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .withMetadata({ density: 300 })
    .toBuffer();
}
