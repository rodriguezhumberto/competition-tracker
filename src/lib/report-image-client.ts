import { createPreviewRenderer } from './report-preview-renderer.ts';
import { adjustCropField, moveCrop } from './report-crop-editor.ts';
import type { PageBoundary } from './page-boundary.ts';
import { fullReportCrop, validateReportCrop, type ReportCrop } from './report-crop.ts';
import type { ReportOrientation } from './report-orientation.ts';
import { uploadPosition, restoreUploadPosition } from './report-upload-position.ts';
// Browser image decoding honors EXIF orientation before we apply manual rotation.
export function reportImagePreview() {
  const renderer = createPreviewRenderer();
  let previewFrame: number | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let selection = 0;
  let detection = 0;
  let pageDetection = 0;
  let pageController: AbortController | null = null;
  let controller: AbortController | null = null;
  let drag: {
    id: number;
    mode: string;
    startX: number;
    startY: number;
    rect: DOMRect;
    crop: ReportCrop;
  } | null = null;
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  return {
    file: null as File | null,
    filename: '',
    imagePreview: '',
    rotation: 0,
    fineRotation: 0,
    straightening: false,
    previewAdjusting: false,
    imageLoading: false,
    detectingOrientation: false,
    orientation: null as ReportOrientation | null,
    orientationMessage: '',
    crop: null as ReportCrop | null,
    cropDraft: fullReportCrop(),
    cropping: false,
    cropMessage: '',
    pageBoundary: null as PageBoundary | null,
    detectingPageBoundary: false,
    pageBoundaryMessage: '',
    cancelOrientation() {
      ++detection;
      controller?.abort();
      controller = null;
      this.detectingOrientation = false;
    },
    async selectImage(event: Event) {
      const root = (event.target as HTMLElement).closest<HTMLElement>('[data-report-workflow]');
      const top = root ? uploadPosition(root) : null;
      const current = ++selection;
      this.cancelPreviewRender();
      this.cancelOrientation();
      this.cancelPageBoundary();
      this.pageBoundary = null;
      this.pageBoundaryMessage = '';
      this.clearCrop();
      this.orientation = null;
      this.orientationMessage = '';
      Object.assign(this, { error: '' });
      renderer.clear();
      this.file = (event.target as HTMLInputElement).files?.[0] || null;
      this.filename = this.file?.name || '';
      this.rotation = 0;
      this.fineRotation = 0;
      this.straightening = false;
      this.imagePreview = '';
      this.imageLoading = false;
      if (!this.file) return;
      this.imageLoading = true;
      try {
        if (this.file.size > 5 * 1024 * 1024) throw new Error('Choose an image under 5 MB.');
        const decoded = await createImageBitmap(this.file, { imageOrientation: 'from-image' });
        if (current !== selection) {
          decoded.close();
          return;
        }
        if (decoded.width * decoded.height > 40_000_000) {
          decoded.close();
          throw new Error('Choose an image under 40 megapixels.');
        }
        renderer.setImage(decoded);
        this.renderImage();
        void this.detectOrientation();
      } catch (error) {
        if (current === selection) {
          this.file = null;
          this.filename = '';
          Object.assign(this, {
            error: error instanceof Error ? error.message : 'Unable to preview this image.',
          });
        }
      } finally {
        if (current === selection) this.imageLoading = false;
        if (current === selection && root && top !== null) await restoreUploadPosition(root, top);
      }
    },
    resetImage() {
      ++selection;
      this.cancelPreviewRender();
      this.cancelOrientation();
      this.cancelPageBoundary();
      renderer.clear();
      this.clearCrop();
      this.file = null;
      this.filename = '';
      this.imagePreview = '';
      this.rotation = 0;
      this.fineRotation = 0;
      this.straightening = false;
      this.imageLoading = false;
      this.previewAdjusting = false;
      this.orientation = null;
      this.orientationMessage = '';
      this.pageBoundary = null;
      this.pageBoundaryMessage = '';
      this.cropMessage = '';
    },
    async detectOrientation() {
      if (!this.file || !renderer.ready) return;
      this.cancelOrientation();
      const current = detection,
        selected = selection;
      controller = new AbortController();
      this.detectingOrientation = true;
      this.orientation = null;
      this.orientationMessage = 'Checking text orientation…';
      try {
        const body = new FormData();
        body.set('report', this.file);
        const response = await fetch('/api/orientation', {
          method: 'POST',
          body,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
        });
        const result = (await response.json()) as ReportOrientation;
        if (current !== detection || selected !== selection) return;
        if (!response.ok)
          throw new Error('Detection unavailable. Check the preview and rotate manually.');
        this.orientation = result;
        if (result.status === 'confident' && result.rotation !== null) {
          this.setImageRotation(result.rotation);
          this.orientationMessage =
            result.rotation === 0
              ? 'Text appears upright. Check the preview before reading.'
              : 'Automatically rotated the report ' +
                result.rotation +
                '°. Check the preview before reading.';
        } else {
          this.orientationMessage =
            result.rotation !== null
              ? 'Orientation is uncertain. Review the suggested rotation or rotate manually.'
              : 'Could not determine text orientation. Check the preview and rotate manually.';
        }
      } catch (error) {
        if (current === detection && selected === selection)
          this.orientationMessage = 'Detection unavailable. Check the preview and rotate manually.';
      } finally {
        if (current === detection && selected === selection) {
          this.detectingOrientation = false;
          controller = null;
          void this.detectPageBoundary();
        }
      }
    },
    cancelPageBoundary() {
      ++pageDetection;
      pageController?.abort();
      pageController = null;
      this.detectingPageBoundary = false;
    },
    async detectPageBoundary() {
      if (!this.file || !renderer.ready || this.cropping || this.crop) return;
      this.cancelPageBoundary();
      this.pageBoundary = null;
      const current = pageDetection,
        selected = selection,
        rotation = this.rotation;
      pageController = new AbortController();
      this.detectingPageBoundary = true;
      this.pageBoundaryMessage = 'Looking for the page boundary…';
      try {
        const body = new FormData();
        body.set('report', this.file);
        body.set('rotation', String(rotation));
        const response = await fetch('/api/page-boundary', {
          method: 'POST',
          body,
          signal: AbortSignal.any([pageController.signal, AbortSignal.timeout(15_000)]),
        });
        const result = (await response.json()) as PageBoundary;
        if (current !== pageDetection || selected !== selection || rotation !== this.rotation)
          return;
        if (!response.ok) throw new Error('Page detection unavailable.');
        this.pageBoundary = result;
        this.pageBoundaryMessage =
          result.status === 'suggested'
            ? 'A page boundary was found. The whole image is still selected; review the suggested crop before applying it.'
            : result.reason === 'already_framed'
              ? 'Image appears already framed. Keeping the whole image.'
              : 'No clear page boundary found. Keep the whole image or crop manually.';
      } catch {
        if (current === pageDetection && selected === selection)
          this.pageBoundaryMessage =
            'Page detection unavailable. Keep the whole image or crop manually.';
      } finally {
        if (current === pageDetection && selected === selection) {
          this.detectingPageBoundary = false;
          pageController = null;
        }
      }
    },
    reviewPageBoundary() {
      if (!this.pageBoundary?.crop) return;
      const suggested = validateReportCrop(this.pageBoundary.crop);
      this.beginCrop();
      this.cropDraft = { ...suggested };
      this.pageBoundaryMessage =
        'Review the suggested rectangle. Keep headers, dates and all participant rows, then apply or adjust the crop.';
    },
    keepWholeImage() {
      this.resetCrop();
      this.pageBoundaryMessage = 'Keeping the whole image.';
    },
    applySuggestedOrientation() {
      if (this.orientation?.rotation === null || !this.orientation) return;
      this.cancelOrientation();
      this.setImageRotation(this.orientation.rotation);
      this.orientationMessage = 'Suggested rotation applied. Check that the text is upright.';
    },
    cancelPreviewRender() {
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      if (settleTimer !== null) clearTimeout(settleTimer);
      previewFrame = null;
      settleTimer = null;
      this.previewAdjusting = false;
    },
    renderImage() {
      this.cancelPreviewRender();
      this.imagePreview = renderer.render(this);
    },
    rotateImage(degrees: number) {
      this.cancelOrientation();
      this.orientation = null;
      this.orientationMessage = 'Manual rotation selected.';
      this.setImageRotation(
        Math.round(((this.rotation + degrees + 360) % 360) * 10) / 10,
        this.fineRotation,
      );
    },
    straightenImage(value: number, canvas: HTMLCanvasElement) {
      const angle = Math.round(clamp(value, -45, 45) * 10) / 10;
      if (!Number.isFinite(angle) || angle === this.fineRotation) return;
      this.cancelOrientation();
      this.orientation = null;
      this.orientationMessage = 'Manual rotation selected.';
      const rotation =
        Math.round(((this.rotation - this.fineRotation + angle + 360) % 360) * 10) / 10;
      this.setImageRotation(rotation === 360 ? 0 : rotation, angle, false, true);
      this.previewAdjusting = true;
      // Coalesce input events into one draw per display frame, without PNG encoding.
      if (previewFrame === null)
        previewFrame = requestAnimationFrame(() => {
          previewFrame = null;
          renderer.drawLive(canvas, this);
        });
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        this.renderImage();
        void this.detectPageBoundary();
      }, 350);
    },
    clearCrop() {
      drag = null;
      this.crop = null;
      this.cropDraft = fullReportCrop();
      this.cropping = false;
      this.cropMessage = '';
    },
    setImageRotation(
      rotation: number,
      fineRotation = 0,
      detectBoundary = true,
      deferPreview = false,
    ) {
      if (rotation !== this.rotation) {
        const hadCrop = !!this.crop || this.cropping;
        this.clearCrop();
        if (hadCrop) this.cropMessage = 'Crop reset because the image rotation changed.';
      }
      this.cancelPageBoundary();
      this.pageBoundary = null;
      this.pageBoundaryMessage = '';
      this.rotation = rotation;
      this.fineRotation = fineRotation;
      if (!deferPreview) this.renderImage();
      if (detectBoundary && !this.detectingOrientation) void this.detectPageBoundary();
    },
    beginCrop() {
      this.cancelPageBoundary();
      this.pageBoundary = null;
      this.pageBoundaryMessage = '';
      this.cancelOrientation();
      this.orientation = null;
      this.orientationMessage = 'Check that the text is upright before cropping.';
      this.cropDraft = { ...(this.crop || fullReportCrop()) };
      this.cropping = true;
      this.cropMessage = '';
      this.renderImage();
    },
    applyCrop() {
      this.pageBoundary = null;
      this.pageBoundaryMessage = '';
      this.crop = validateReportCrop(this.cropDraft);
      this.cropping = false;
      drag = null;
      if (this.crop.x === 0 && this.crop.y === 0 && this.crop.width === 1 && this.crop.height === 1)
        this.crop = null;
      this.cropMessage = this.crop
        ? 'Crop applied. Check that headers, dates and all participant rows remain visible.'
        : 'Using the whole report image.';
      this.renderImage();
    },
    cancelCrop() {
      this.pageBoundaryMessage = '';
      this.cropping = false;
      drag = null;
      this.renderImage();
    },
    resetCrop() {
      this.cancelPageBoundary();
      this.pageBoundary = null;
      this.pageBoundaryMessage = '';
      this.clearCrop();
      this.cropMessage = 'Using the whole report image.';
      this.renderImage();
    },
    updateCropField(field: keyof ReportCrop, event: Event) {
      this.cropDraft = adjustCropField(
        this.cropDraft,
        field,
        Number((event.target as HTMLInputElement).value),
      );
    },
    changeCrop(mode: string, dx: number, dy: number, origin: ReportCrop) {
      this.cropDraft = moveCrop(origin, mode, dx, dy);
    },
    startCropDrag(event: PointerEvent) {
      if (!this.cropping || (event.button !== 0 && event.pointerType === 'mouse')) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-crop-handle]');
      if (!target) return;
      const stage = event.currentTarget as HTMLElement;
      drag = {
        id: event.pointerId,
        mode: target.dataset.cropHandle!,
        startX: event.clientX,
        startY: event.clientY,
        rect: stage.getBoundingClientRect(),
        crop: { ...this.cropDraft },
      };
      stage.setPointerCapture(event.pointerId);
      target.focus();
      event.preventDefault();
    },
    moveCropDrag(event: PointerEvent) {
      if (!drag || drag.id !== event.pointerId || !this.cropping) return;
      this.changeCrop(
        drag.mode,
        (event.clientX - drag.startX) / drag.rect.width,
        (event.clientY - drag.startY) / drag.rect.height,
        drag.crop,
      );
    },
    endCropDrag(event: PointerEvent) {
      if (drag?.id === event.pointerId) drag = null;
    },
    cropKeyboard(event: KeyboardEvent, mode: string) {
      if (
        !this.cropping ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 0.05 : 0.01;
      this.changeCrop(
        mode,
        event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
        this.cropDraft,
      );
    },
    destroy() {
      this.cancelPreviewRender();
      this.cancelOrientation();
      this.cancelPageBoundary();
      ++selection;
      renderer.clear();
    },
  };
}
