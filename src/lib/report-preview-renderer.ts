import { cropPixels, type ReportCrop } from './report-crop.ts';

interface PreviewView {
  rotation: number;
  crop: ReportCrop | null;
  cropping: boolean;
}

// Own decoded pixels and their lifetime separately from form/request state.
export function createPreviewRenderer() {
  let bitmap: ImageBitmap | null = null;
  let liveSource: HTMLCanvasElement | null = null;

  function clear() {
    bitmap?.close();
    bitmap = null;
    liveSource = null;
  }

  function draw(canvas: HTMLCanvasElement, source: CanvasImageSource, view: PreviewView) {
    if (!bitmap) return;
    const radians = (view.rotation * Math.PI) / 180;
    const cosine = Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians));
    const width = Math.round(bitmap.width * cosine + bitmap.height * sine);
    const height = Math.round(bitmap.width * sine + bitmap.height * cosine);
    const region =
      !view.cropping && view.crop
        ? cropPixels(view.crop, width, height)
        : { left: 0, top: 0, width, height };
    const scale = Math.min(1, 1200 / Math.max(region.width, region.height));
    canvas.width = Math.max(1, Math.round(region.width * scale));
    canvas.height = Math.max(1, Math.round(region.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to preview this image.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(canvas.width / region.width, canvas.height / region.height);
    context.translate(-region.left, -region.top);
    context.translate(width / 2, height / 2);
    context.rotate(radians);
    context.drawImage(source, -bitmap.width / 2, -bitmap.height / 2, bitmap.width, bitmap.height);
  }

  return {
    get ready() {
      return bitmap !== null;
    },
    clear,
    setImage(decoded: ImageBitmap) {
      clear();
      bitmap = decoded;
      liveSource = document.createElement('canvas');
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      liveSource.width = Math.max(1, Math.round(bitmap.width * scale));
      liveSource.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = liveSource.getContext('2d');
      if (!context) throw new Error('Unable to preview this image.');
      context.drawImage(bitmap, 0, 0, liveSource.width, liveSource.height);
    },
    drawLive(canvas: HTMLCanvasElement, view: PreviewView) {
      if (liveSource) draw(canvas, liveSource, view);
    },
    render(view: PreviewView) {
      if (!bitmap) return '';
      const canvas = document.createElement('canvas');
      draw(canvas, bitmap, view);
      return canvas.toDataURL('image/png');
    },
  };
}
