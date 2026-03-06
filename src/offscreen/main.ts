import type {
  CaptureTilePayload,
  ExportFile,
  ExportFormat,
  ExportOptions,
  RuntimeResponse
} from '../shared/messages';
import { DEFAULT_EXPORT_OPTIONS } from '../shared/constants';

const MAX_PRIMARY_DIMENSION = 15000 * 2;
const MAX_SECONDARY_DIMENSION = 4000 * 2;
const MAX_AREA = MAX_PRIMARY_DIMENSION * MAX_SECONDARY_DIMENSION;

type CanvasLike = OffscreenCanvas | HTMLCanvasElement;
type Canvas2DContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface ScreenshotSlice {
  canvas: CanvasLike;
  ctx: Canvas2DContext;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface OffscreenJob {
  slices: ScreenshotSlice[];
}

interface AddTileMessage {
  type: 'offscreen-add-tile';
  jobId: string;
  tile: CaptureTilePayload;
  dataUrl: string;
}

interface ExportMessage {
  type: 'offscreen-export';
  jobId: string;
  options?: Partial<ExportOptions>;
  metadata?: {
    pageUrl?: string;
    capturedAtIso?: string;
  };
}

interface ClearMessage {
  type: 'offscreen-clear';
  jobId: string;
}

interface ResetMessage {
  type: 'offscreen-reset';
  jobId: string;
}

interface CropExportMessage {
  type: 'offscreen-export-visible-area';
  dataUrl: string;
  area: {
    x: number;
    y: number;
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  options?: Partial<ExportOptions>;
}

type OffscreenMessage = AddTileMessage | ExportMessage | ClearMessage | ResetMessage | CropExportMessage;
type JsPdfModule = typeof import('jspdf');

const JOB_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_PURGE_INTERVAL_MS = 60 * 1000;
const jobs = new Map<string, OffscreenJob>();
const jobTimestamps = new Map<string, number>();
let jsPdfPromise: Promise<JsPdfModule> | null = null;

/** Purge jobs older than TTL to prevent memory leaks */
function purgeStaleJobs(): void {
  const now = Date.now();
  for (const [id, timestamp] of jobTimestamps) {
    if (now - timestamp > JOB_TTL_MS) {
      jobs.delete(id);
      jobTimestamps.delete(id);
    }
  }
}

function getJsPdf(): Promise<JsPdfModule> {
  if (!jsPdfPromise) {
    jsPdfPromise = import('jspdf').catch((error) => {
      jsPdfPromise = null;
      throw error;
    });
  }
  return jsPdfPromise;
}

setInterval(() => {
  purgeStaleJobs();
}, STALE_PURGE_INTERVAL_MS);

function getOrCreateJob(jobId: string): OffscreenJob {
  // Purge stale jobs before creating/accessing
  purgeStaleJobs();

  let job = jobs.get(jobId);
  if (!job) {
    job = { slices: [] };
    jobs.set(jobId, job);
  }
  // Update timestamp on access
  jobTimestamps.set(jobId, Date.now());
  return job;
}

function normalizeExportOptions(input?: Partial<ExportOptions>): ExportOptions {
  return {
    ...DEFAULT_EXPORT_OPTIONS,
    ...(input ?? {}),
    jpgQuality: Math.max(
      0.4,
      Math.min(1, Number(input?.jpgQuality ?? DEFAULT_EXPORT_OPTIONS.jpgQuality))
    )
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function validateTilePayload(tile: CaptureTilePayload): string | null {
  if (!isFiniteNumber(tile.complete)) {
    return '`complete` must be a finite number.';
  }
  if (!isNonNegativeFiniteNumber(tile.x) || !isNonNegativeFiniteNumber(tile.y)) {
    return '`x`/`y` must be finite numbers >= 0.';
  }
  if (!isPositiveFiniteNumber(tile.windowWidth)) {
    return '`windowWidth` must be a finite number > 0.';
  }
  if (tile.windowHeight !== undefined && !isPositiveFiniteNumber(tile.windowHeight)) {
    return '`windowHeight` must be a finite number > 0 when provided.';
  }
  if (!isPositiveFiniteNumber(tile.totalWidth) || !isPositiveFiniteNumber(tile.totalHeight)) {
    return '`totalWidth`/`totalHeight` must be finite numbers > 0.';
  }
  if (!isPositiveFiniteNumber(tile.devicePixelRatio)) {
    return '`devicePixelRatio` must be a finite number > 0.';
  }
  return null;
}

function createCanvas(width: number, height: number): { canvas: CanvasLike; ctx: Canvas2DContext } {
  if ('OffscreenCanvas' in self) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to create offscreen 2D context.');
    }
    return { canvas, ctx };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to create canvas context.');
  }
  return { canvas, ctx };
}

function cloneCanvas(source: CanvasLike): { canvas: CanvasLike; ctx: Canvas2DContext } {
  const width = source.width;
  const height = source.height;
  const { canvas, ctx } = createCanvas(width, height);
  ctx.drawImage(source as CanvasImageSource, 0, 0);
  return { canvas, ctx };
}

function initSlices(totalWidth: number, totalHeight: number): ScreenshotSlice[] {
  if (!isPositiveFiniteNumber(totalWidth) || !isPositiveFiniteNumber(totalHeight)) {
    throw new Error('Invalid total dimensions for export slices.');
  }

  const badSize =
    totalHeight > MAX_PRIMARY_DIMENSION ||
    totalWidth > MAX_PRIMARY_DIMENSION ||
    totalHeight * totalWidth > MAX_AREA;
  const biggerWidth = totalWidth > totalHeight;
  const maxWidth = !badSize
    ? totalWidth
    : biggerWidth
      ? MAX_PRIMARY_DIMENSION
      : MAX_SECONDARY_DIMENSION;
  const maxHeight = !badSize
    ? totalHeight
    : biggerWidth
      ? MAX_SECONDARY_DIMENSION
      : MAX_PRIMARY_DIMENSION;
  const numCols = Math.ceil(totalWidth / maxWidth);
  const numRows = Math.ceil(totalHeight / maxHeight);

  const result: ScreenshotSlice[] = [];
  for (let row = 0; row < numRows; row += 1) {
    for (let col = 0; col < numCols; col += 1) {
      const width = col === numCols - 1 ? totalWidth % maxWidth || maxWidth : maxWidth;
      const height = row === numRows - 1 ? totalHeight % maxHeight || maxHeight : maxHeight;
      const left = col * maxWidth;
      const top = row * maxHeight;
      const { canvas, ctx } = createCanvas(width, height);

      result.push({
        canvas,
        ctx,
        left,
        top,
        right: left + width,
        bottom: top + height
      });
    }
  }

  return result;
}

function matchingSlices(
  x: number,
  y: number,
  width: number,
  height: number,
  slices: ScreenshotSlice[]
): ScreenshotSlice[] {
  const right = x + width;
  const bottom = y + height;
  return slices.filter((slice) => {
    return x < slice.right && right > slice.left && y < slice.bottom && bottom > slice.top;
  });
}

async function decodeImage(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function canvasToBlob(
  canvas: CanvasLike,
  format: ExportFormat,
  jpgQuality: number
): Promise<Blob> {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const quality = format === 'jpg' ? jpgQuality : undefined;

  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Unable to encode canvas blob.'));
      },
      mime,
      quality
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to convert blob to data URL.'));
      }
    };
    reader.onerror = () => reject(new Error('Unable to read blob.'));
    reader.readAsDataURL(blob);
  });
}

async function exportAsRaster(
  slices: ScreenshotSlice[],
  options: ExportOptions
): Promise<ExportFile[]> {
  const files: ExportFile[] = [];
  for (const slice of slices) {
    const { canvas } = cloneCanvas(slice.canvas);
    const blob = await canvasToBlob(canvas, options.format, options.jpgQuality);
    files.push({
      dataUrl: await blobToDataUrl(blob),
      extension: options.format
    });
  }
  return files;
}

async function exportAsPdf(slices: ScreenshotSlice[]): Promise<ExportFile[]> {
  const { jsPDF } = await getJsPdf();
  let pdf: InstanceType<typeof jsPDF> | null = null;

  for (const slice of slices) {
    const { canvas } = cloneCanvas(slice.canvas);
    const imageDataUrl = await blobToDataUrl(await canvasToBlob(canvas, 'png', 1));
    const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
    const pageSize: [number, number] = [canvas.width, canvas.height];

    if (!pdf) {
      pdf = new jsPDF({
        orientation,
        unit: 'px',
        format: pageSize,
        compress: true
      });
    } else {
      pdf.addPage(pageSize, orientation);
    }

    pdf.addImage(imageDataUrl, 'PNG', 0, 0, canvas.width, canvas.height, undefined, 'FAST');
  }

  if (!pdf) {
    throw new Error('No slices to export as PDF.');
  }

  const pdfBlob = pdf.output('blob');
  return [
    {
      dataUrl: await blobToDataUrl(pdfBlob),
      extension: 'pdf'
    }
  ];
}

async function addTile(message: AddTileMessage): Promise<RuntimeResponse<{ splitCount: number }>> {
  const job = getOrCreateJob(message.jobId);
  const image = await decodeImage(message.dataUrl);

  try {
    const tile = { ...message.tile };
    const tileValidationError = validateTilePayload(tile);
    if (tileValidationError) {
      return { ok: false, error: `Invalid tile payload: ${tileValidationError}` };
    }
    if (!isPositiveFiniteNumber(image.width) || !isPositiveFiniteNumber(image.height)) {
      return { ok: false, error: 'Invalid captured tile dimensions.' };
    }

    // Scale both width and height dimensions if window size differs from image
    const windowHeight = tile.windowHeight ?? image.height;
    if (!isPositiveFiniteNumber(windowHeight)) {
      return { ok: false, error: 'Invalid window dimensions in tile payload.' };
    }
    const scaleX = image.width / tile.windowWidth;
    const scaleY = image.height / windowHeight;
    if (!isPositiveFiniteNumber(scaleX) || !isPositiveFiniteNumber(scaleY)) {
      return { ok: false, error: 'Invalid tile scaling factors.' };
    }
    if (scaleX !== 1 || scaleY !== 1) {
      tile.x *= scaleX;
      tile.y *= scaleY;
      tile.totalWidth *= scaleX;
      tile.totalHeight *= scaleY;
      if (
        !isNonNegativeFiniteNumber(tile.x) ||
        !isNonNegativeFiniteNumber(tile.y) ||
        !isPositiveFiniteNumber(tile.totalWidth) ||
        !isPositiveFiniteNumber(tile.totalHeight)
      ) {
        return { ok: false, error: 'Invalid scaled tile dimensions.' };
      }
    }

    if (!job.slices.length) {
      job.slices = initSlices(tile.totalWidth, tile.totalHeight);
    }

    const targets = matchingSlices(tile.x, tile.y, image.width, image.height, job.slices);
    targets.forEach((slice) => {
      slice.ctx.drawImage(image, tile.x - slice.left, tile.y - slice.top);
    });

    return { ok: true, data: { splitCount: job.slices.length } };
  } finally {
    image.close();
  }
}

async function exportJob(
  message: ExportMessage
): Promise<RuntimeResponse<{ captures: ExportFile[] }>> {
  const job = jobs.get(message.jobId);
  if (!job || !job.slices.length) {
    return { ok: false, error: 'No captured slices for this job.' };
  }

  const options = normalizeExportOptions(message.options);
  let captures: ExportFile[];
  if (options.format === 'pdf') {
    captures = await exportAsPdf(job.slices);
  } else {
    captures = await exportAsRaster(job.slices, options);
  }

  return { ok: true, data: { captures } };
}

async function exportVisibleArea(
  message: CropExportMessage
): Promise<RuntimeResponse<{ captures: ExportFile[] }>> {
  const options = normalizeExportOptions(message.options);
  const image = await decodeImage(message.dataUrl);

  try {
    const scale = Math.max(1, message.area.devicePixelRatio || 1);
    const sx = Math.max(0, Math.round(message.area.x * scale));
    const sy = Math.max(0, Math.round(message.area.y * scale));
    const sw = Math.max(1, Math.round(message.area.width * scale));
    const sh = Math.max(1, Math.round(message.area.height * scale));
    const maxWidth = Math.max(1, image.width - sx);
    const maxHeight = Math.max(1, image.height - sy);
    const cropWidth = Math.min(sw, maxWidth);
    const cropHeight = Math.min(sh, maxHeight);
    const { canvas, ctx } = createCanvas(cropWidth, cropHeight);
    ctx.drawImage(image, sx, sy, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const slice: ScreenshotSlice = {
      canvas,
      ctx,
      left: 0,
      top: 0,
      right: cropWidth,
      bottom: cropHeight
    };

    const captures =
      options.format === 'pdf'
        ? await exportAsPdf([slice])
        : await exportAsRaster([slice], options);

    return { ok: true, data: { captures } };
  } finally {
    image.close();
  }
}

function clearJob(message: ClearMessage): RuntimeResponse {
  jobs.delete(message.jobId);
  jobTimestamps.delete(message.jobId);
  // Opportunistically purge other stale jobs
  purgeStaleJobs();
  return { ok: true };
}

function resetJob(message: ResetMessage): RuntimeResponse {
  // Purge all stale jobs before resetting to clean up any leaked memory
  purgeStaleJobs();
  jobs.set(message.jobId, { slices: [] });
  jobTimestamps.set(message.jobId, Date.now());
  return { ok: true };
}

function isMessage(value: unknown): value is OffscreenMessage {
  return Boolean(value) && typeof value === 'object' && 'type' in (value as object);
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (!isMessage(message)) {
    return false;
  }

  switch (message.type) {
    case 'offscreen-add-tile':
      void addTile(message)
        .then((response) => sendResponse(response))
        .catch((error) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
        );
      return true;

    case 'offscreen-export':
      void exportJob(message)
        .then((response) => sendResponse(response))
        .catch((error) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
        );
      return true;

    case 'offscreen-export-visible-area':
      void exportVisibleArea(message)
        .then((response) => sendResponse(response))
        .catch((error) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
        );
      return true;

    case 'offscreen-clear':
      sendResponse(clearJob(message));
      return false;

    case 'offscreen-reset':
      sendResponse(resetJob(message));
      return false;

    default:
      return false;
  }
});
