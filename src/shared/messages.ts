export type CaptureState = 'idle' | 'running' | 'done' | 'error';
export type CapturePhase = 'preflight' | 'capture' | 'export';

export interface CaptureStatus {
  state: CaptureState;
  progress: number;
  startedAt?: number;
  pageUrl?: string;
  splitCount: number;
  downloadedCount: number;
  totalCount: number;
  phase?: CapturePhase;
  phaseProgress?: number;
  phaseDetail?: string;
  error?: string;
  notice?: string;
}

export interface CaptureOptions {
  enableSmartScroll: boolean;
  lazyLoadWaitMs: number;
  settleFrames: number;
  heightGrowthThresholdPx: number;
  maxExtraHeightPx: number;
  maxCaptureHeightPx: number;
}

export type ExportFormat = 'png' | 'jpg' | 'pdf';

export interface ExportOptions {
  format: ExportFormat;
  jpgQuality: number;
}

export interface DownloadOptions {
  askWhereToSave: boolean;
}

export interface ExportFile {
  dataUrl: string;
  extension: ExportFormat;
}

export interface CaptureTilePayload {
  x: number;
  y: number;
  complete: number;
  windowWidth: number;
  windowHeight?: number;
  totalWidth: number;
  totalHeight: number;
  devicePixelRatio: number;
}

export interface RuntimeOkResponse<T = undefined> {
  ok: true;
  data?: T;
}

export interface RuntimeErrorResponse {
  ok: false;
  error: string;
}

export type RuntimeResponse<T = undefined> = RuntimeOkResponse<T> | RuntimeErrorResponse;
