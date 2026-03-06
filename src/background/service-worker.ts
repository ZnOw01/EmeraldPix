import type {
  CaptureOptions,
  CaptureStatus,
  CaptureTilePayload,
  ExportFile,
  ExportOptions,
  RuntimeResponse
} from '../shared/messages';
import { readPersistedValue } from '../shared/persisted-store';
import {
  CAPTURE_PROTOCOLS,
  BLOCKED_URLS,
  BLOCKED_HTTP_URLS,
  JOB_TIMEOUT_MS,
  PREFLIGHT_PROGRESS_WEIGHT,
  CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS,
  CAPTURE_VISIBLE_TAB_MAX_RETRIES,
  CAPTURE_VISIBLE_TAB_BACKOFF_BASE_MS,
  CAPTURE_VISIBLE_TAB_BACKOFF_MAX_MS,
  DOWNLOAD_COMPLETION_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
  DEFAULT_CAPTURE_OPTIONS,
  DEFAULT_EXPORT_OPTIONS
} from '../shared/constants';

interface StartCaptureResponse {
  status: CaptureStatus;
  alreadyRunning: boolean;
}

interface ActiveJob {
  id: string;
  tabId: number;
  windowId: number;
  filename: string;
  usesPreflight: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface OffscreenAddTileResponse {
  splitCount: number;
}

interface OffscreenExportResponse {
  captures: ExportFile[];
}

interface VisibleAreaSelection {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

type RuntimeMessage =
  | { type: 'start-capture' }
  | { type: 'start-area-capture' }
  | { type: 'start-capture-target'; tabId: number }
  | { type: 'get-capture-status' }
  | {
      type: 'capture-preflight-progress';
      jobId: string;
      progress: number;
      pass: number;
      maxPasses: number;
      elapsedMs: number;
      maxDurationMs: number;
      limitReason?: 'pass' | 'time';
      detail?: string;
    }
  | { type: 'capture-tile'; jobId: string; tile: CaptureTilePayload }
  | { type: 'capture-finished'; jobId: string }
  | { type: 'capture-failed'; jobId: string; error?: string };

// DEV_MODE flag injected by Vite - only true in development builds
declare const __DEV_MODE__: boolean;
declare const __BUILD_ID__: string;

const CAPTURE_VISIBLE_TAB_QUOTA_PATTERNS = [
  /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i,
  /captureVisibleTab.*quota/i,
  /Too many captureVisibleTab calls/i
];
const DEV_RELOAD_ALARM = 'dev-reload-check';
const DEV_RELOAD_PERIOD_MINUTES = 0.05;

let activeJob: ActiveJob | null = null;
let status: CaptureStatus = {
  state: 'idle',
  progress: 0,
  splitCount: 1,
  downloadedCount: 0,
  totalCount: 0
};
let offscreenCreationPromise: Promise<void> | null = null;
let captureVisibleTabNextAllowedAt = 0;
let captureVisibleTabRateLimitLock: Promise<void> = Promise.resolve();
let finalizingJobId: string | null = null;
const OFFSCREEN_IDLE_CLOSE_MS = 20_000;
let offscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
}

function updateStatus(next: Partial<CaptureStatus>): void {
  status = { ...status, ...next };
  void chrome.runtime.sendMessage({ type: 'capture-status', status }).catch(() => undefined);
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
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

function formatSeconds(ms: number): string {
  return `${Math.round(Math.max(0, ms) / 1000)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearActiveJobTimeout(): void {
  if (!activeJob || activeJob.timeoutId === null) {
    return;
  }
  clearTimeout(activeJob.timeoutId);
  activeJob.timeoutId = null;
}

function armActiveJobTimeout(jobId: string, timeoutMs: number, timeoutMessage: string): void {
  if (!activeJob || activeJob.id !== jobId) {
    return;
  }
  clearActiveJobTimeout();
  activeJob.timeoutId = setTimeout(() => {
    void failActiveJobById(jobId, timeoutMessage);
  }, timeoutMs);
}

async function failActiveJobById(jobId: string, message: string): Promise<void> {
  if (!activeJob || activeJob.id !== jobId || status.state !== 'running') {
    return;
  }
  await failActiveJob(message);
}

function isCapturableUrl(url?: string): boolean {
  if (!url) {
    return false;
  }
  const normalized = url.toLowerCase();
  if (!CAPTURE_PROTOCOLS.some((protocol) => normalized.startsWith(protocol))) {
    return false;
  }
  if (BLOCKED_URLS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (BLOCKED_HTTP_URLS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return true;
}

// Counter for screenshot numbering within session
let screenshotCounter = 0;

function sanitizeFilename(): string {
  screenshotCounter++;
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toTimeString().slice(0, 5).replace(':', '-'); // HH-MM
  return `Screenshot_${date}_${time}_${screenshotCounter}`;
}

function sanitizeCaptureOptions(input: Partial<CaptureOptions>): CaptureOptions {
  const lazyLoadWaitMs = isPositiveFiniteNumber(input.lazyLoadWaitMs)
    ? Math.round(input.lazyLoadWaitMs)
    : DEFAULT_CAPTURE_OPTIONS.lazyLoadWaitMs;
  const settleFrames = isPositiveFiniteNumber(input.settleFrames)
    ? Math.round(input.settleFrames)
    : DEFAULT_CAPTURE_OPTIONS.settleFrames;
  const heightGrowthThresholdPx = isPositiveFiniteNumber(input.heightGrowthThresholdPx)
    ? Math.round(input.heightGrowthThresholdPx)
    : DEFAULT_CAPTURE_OPTIONS.heightGrowthThresholdPx;
  const maxExtraHeightPx = isPositiveFiniteNumber(input.maxExtraHeightPx)
    ? Math.round(input.maxExtraHeightPx)
    : DEFAULT_CAPTURE_OPTIONS.maxExtraHeightPx;
  const maxCaptureHeightPx = isPositiveFiniteNumber(input.maxCaptureHeightPx)
    ? Math.round(input.maxCaptureHeightPx)
    : DEFAULT_CAPTURE_OPTIONS.maxCaptureHeightPx;

  return {
    ...DEFAULT_CAPTURE_OPTIONS,
    ...input,
    enableSmartScroll: input.enableSmartScroll !== false,
    lazyLoadWaitMs,
    settleFrames,
    heightGrowthThresholdPx,
    maxExtraHeightPx,
    maxCaptureHeightPx
  };
}

function sanitizeExportOptions(input: Partial<ExportOptions>): ExportOptions {
  const format = input.format === 'jpg' || input.format === 'pdf' ? input.format : 'png';
  return {
    ...DEFAULT_EXPORT_OPTIONS,
    ...input,
    format,
    jpgQuality: DEFAULT_EXPORT_OPTIONS.jpgQuality
  };
}

async function loadCaptureOptions(): Promise<CaptureOptions> {
  const value = await readPersistedValue('captureOptions');
  if (!value || typeof value !== 'object') {
    return DEFAULT_CAPTURE_OPTIONS;
  }
  return sanitizeCaptureOptions(value as Partial<CaptureOptions>);
}

async function loadExportOptions(): Promise<ExportOptions> {
  const value = await readPersistedValue('exportOptions');
  if (!value || typeof value !== 'object') {
    return DEFAULT_EXPORT_OPTIONS;
  }
  return sanitizeExportOptions(value as Partial<ExportOptions>);
}

function addFilenameSuffix(
  filename: string,
  index: number,
  extension: ExportOptions['format'],
  totalCount: number
): string {
  const ext = extension === 'jpg' ? 'jpg' : extension;
  if (totalCount <= 1 || index === 0) {
    return `${filename}.${ext}`;
  }
  return `${filename}-${index + 1}.${ext}`;
}

async function ensureOffscreenDocument(): Promise<void> {
  cancelScheduledOffscreenClose();

  // Guard clause: check if chrome.offscreen API is available
  if (typeof chrome.offscreen === 'undefined') {
    throw new Error(
      'chrome.offscreen API is not available. This extension requires Chrome 120 or later. ' +
        'Please update your browser to use EmeraldPix.'
    );
  }

  if (offscreenCreationPromise) {
    await offscreenCreationPromise;
    return;
  }

  offscreenCreationPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Compose full-page screenshots off the visible UI thread.'
      });
    } catch (error) {
      const message = getErrorMessage(error);
      if (!message.includes('Only a single offscreen document')) {
        throw error;
      }
    }
  })();

  try {
    await offscreenCreationPromise;
  } finally {
    offscreenCreationPromise = null;
  }
}

function cancelScheduledOffscreenClose(): void {
  if (offscreenCloseTimer !== null) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
}

function scheduleOffscreenClose(): void {
  cancelScheduledOffscreenClose();
  if (activeJob || finalizingJobId) {
    return;
  }
  offscreenCloseTimer = setTimeout(() => {
    void closeOffscreenDocumentIfIdle();
  }, OFFSCREEN_IDLE_CLOSE_MS);
}

async function closeOffscreenDocumentIfIdle(): Promise<void> {
  if (activeJob || finalizingJobId || typeof chrome.offscreen === 'undefined') {
    return;
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    const message = getErrorMessage(error);
    if (!message.includes('No current offscreen document')) {
      console.warn(`[ServiceWorker] Failed to close offscreen document: ${message}`);
    }
  }
}

async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'capture-ping'
    })) as RuntimeResponse<{ ready?: boolean; buildId?: string }>;
    return Boolean(response.ok && response.data?.ready && response.data?.buildId === __BUILD_ID__);
  } catch {
    return false;
  }
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  if (await pingContentScript(tabId)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['assets/content_script.js']
  });

  const isReady = await pingContentScript(tabId);
  if (!isReady) {
    throw new Error('Content script did not respond after injection.');
  }
}

async function checkForDevBuildUpdate(): Promise<void> {
  if (!__DEV_MODE__) {
    return;
  }

  try {
    const response = await fetch(
      `${chrome.runtime.getURL('build-meta.json')}?t=${Date.now()}`,
      { cache: 'no-store' }
    );
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { buildId?: string };
    if (payload.buildId && payload.buildId !== __BUILD_ID__) {
      chrome.runtime.reload();
    }
  } catch {
    // Ignore transient dev-reload check failures.
  }
}

async function ensureDevReloadAlarm(): Promise<void> {
  if (!__DEV_MODE__) {
    return;
  }

  const existing = await chrome.alarms.get(DEV_RELOAD_ALARM);
  if (!existing) {
    await chrome.alarms.create(DEV_RELOAD_ALARM, {
      periodInMinutes: DEV_RELOAD_PERIOD_MINUTES
    });
  }
}

function isCaptureVisibleTabQuotaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return CAPTURE_VISIBLE_TAB_QUOTA_PATTERNS.some((pattern) => pattern.test(message));
}

function getCaptureVisibleTabRetryDelayMs(attempt: number): number {
  const exponentialMs = Math.min(
    CAPTURE_VISIBLE_TAB_BACKOFF_MAX_MS,
    CAPTURE_VISIBLE_TAB_BACKOFF_BASE_MS * 2 ** attempt
  );
  return Math.max(CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS, exponentialMs);
}

async function waitForCaptureVisibleTabRateLimitSlot(): Promise<void> {
  const previousLock = captureVisibleTabRateLimitLock;
  let releaseLock: () => void = () => undefined;
  captureVisibleTabRateLimitLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    const waitMs = Math.max(0, captureVisibleTabNextAllowedAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    captureVisibleTabNextAllowedAt = Date.now() + CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS;
  } finally {
    releaseLock();
  }
}

async function captureVisibleTabWithRetry(windowId: number): Promise<string> {
  let lastError: unknown = new Error('Unknown capture error.');
  for (let attempt = 0; attempt <= CAPTURE_VISIBLE_TAB_MAX_RETRIES; attempt += 1) {
    await waitForCaptureVisibleTabRateLimitSlot();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      if (!dataUrl) {
        throw new Error('Empty screenshot data.');
      }
      return dataUrl;
    } catch (error) {
      lastError = error;
      if (!isCaptureVisibleTabQuotaError(error) || attempt >= CAPTURE_VISIBLE_TAB_MAX_RETRIES) {
        throw error;
      }
      await sleep(getCaptureVisibleTabRetryDelayMs(attempt));
    }
  }
  throw new Error(getErrorMessage(lastError));
}

async function waitForDownloadCompletion(downloadId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finalizeError(new Error(`Download ${downloadId} did not complete in time.`));
    }, DOWNLOAD_COMPLETION_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    const finalizeSuccess = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const finalizeError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) {
        return;
      }
      if (delta.state?.current === 'complete') {
        finalizeSuccess();
        return;
      }
      if (delta.state?.current === 'interrupted' || delta.error?.current) {
        const code = delta.error?.current;
        finalizeError(new Error(`Download ${downloadId} interrupted${code ? `: ${code}` : '.'}`));
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    void chrome.downloads
      .search({ id: downloadId })
      .then((items) => {
        const current = items[0];
        if (!current) {
          finalizeError(new Error(`Download ${downloadId} was not found.`));
          return;
        }
        if (current.state === 'complete') {
          finalizeSuccess();
          return;
        }
        if (current.state === 'interrupted') {
          finalizeError(
            new Error(
              `Download ${downloadId} interrupted${current.error ? `: ${current.error}` : '.'}`
            )
          );
        }
      })
      .catch((error) => {
        finalizeError(
          new Error(`Unable to inspect download ${downloadId}: ${getErrorMessage(error)}`)
        );
      });
  });
}

async function failActiveJob(message: string): Promise<void> {
  clearActiveJobTimeout();
  if (activeJob) {
    await chrome.runtime
      .sendMessage({ type: 'offscreen-clear', jobId: activeJob.id })
      .catch(() => undefined);
  }
  activeJob = null;
  scheduleOffscreenClose();
  updateStatus({
    state: 'error',
    error: message,
    phase: undefined,
    phaseProgress: undefined,
    phaseDetail: undefined
  });
}

async function startCapture(): Promise<RuntimeResponse<StartCaptureResponse>> {
  return startCaptureForTab();
}

async function startAreaCapture(): Promise<RuntimeResponse<StartCaptureResponse>> {
  if (activeJob && status.state === 'running') {
    return { ok: true, data: { status, alreadyRunning: true } };
  }

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id || !tab.windowId) {
    return { ok: false, error: 'No active tab found.' };
  }
  if (!isCapturableUrl(tab.url)) {
    return { ok: false, error: 'This URL cannot be captured by Chrome extension policy.' };
  }

  const job: ActiveJob = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    filename: sanitizeFilename(),
    usesPreflight: false,
    timeoutId: null
  };
  activeJob = job;
  armActiveJobTimeout(job.id, EXPORT_TIMEOUT_MS, 'Area capture timed out.');

  updateStatus({
    state: 'running',
    progress: 0,
    startedAt: Date.now(),
    pageUrl: tab.url,
    splitCount: 1,
    downloadedCount: 0,
    totalCount: 1,
    phase: 'capture',
    phaseProgress: 0,
    phaseDetail: 'Select an area.',
    error: undefined,
    notice: undefined
  });

  try {
    await ensureOffscreenDocument();
    await ensureContentScriptInjected(tab.id);

    const selectionResponse = (await chrome.tabs.sendMessage(tab.id, {
      type: 'select-area'
    })) as RuntimeResponse<VisibleAreaSelection>;

    if (!selectionResponse.ok || !selectionResponse.data) {
      throw new Error(selectionResponse.ok ? 'Area selection cancelled.' : selectionResponse.error);
    }

    updateStatus({
      progress: 0.35,
      phaseDetail: 'Capturing area...'
    });

    const exportOptions = await loadExportOptions();

    const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
    const exported = (await chrome.runtime.sendMessage({
      type: 'offscreen-export-visible-area',
      dataUrl,
      area: selectionResponse.data,
      options: exportOptions
    })) as RuntimeResponse<OffscreenExportResponse>;

    if (!exported.ok) {
      throw new Error(exported.error || 'Area export failed.');
    }

    const captures = exported.data?.captures ?? [];
    if (!captures.length) {
      throw new Error('No screenshots were generated.');
    }

    updateStatus({
      progress: 0.7,
      phase: 'export',
      phaseProgress: 0.7,
      phaseDetail: 'Saving...'
    });

    for (let i = 0; i < captures.length; i += 1) {
      const item = captures[i];
      const downloadId = await chrome.downloads.download({
        url: item.dataUrl,
        filename: addFilenameSuffix(job.filename, i, item.extension, captures.length),
        conflictAction: 'uniquify'
      });
      if (typeof downloadId !== 'number') {
        throw new Error(`Download ${i + 1}/${captures.length} did not start.`);
      }
      await waitForDownloadCompletion(downloadId);
      updateStatus({
        downloadedCount: i + 1,
        progress: 1,
        phaseProgress: 1
      });
    }

    clearActiveJobTimeout();
    activeJob = null;
    scheduleOffscreenClose();
    updateStatus({
      state: 'done',
      phase: undefined,
      phaseProgress: undefined,
      phaseDetail: undefined
    });
    return { ok: true, data: { status, alreadyRunning: false } };
  } catch (error) {
    const message = getErrorMessage(error);
    if (message === 'Area selection cancelled.') {
      clearActiveJobTimeout();
      activeJob = null;
      scheduleOffscreenClose();
      status = {
        state: 'idle',
        progress: 0,
        splitCount: 1,
        downloadedCount: 0,
        totalCount: 0
      };
      return { ok: false, error: 'Area selection cancelled.' };
    }
    await failActiveJob(message);
    return { ok: false, error: message };
  }
}

async function startCaptureForTab(tabId?: number): Promise<RuntimeResponse<StartCaptureResponse>> {
  if (activeJob && status.state === 'running') {
    return { ok: true, data: { status, alreadyRunning: true } };
  }

  let tab: chrome.tabs.Tab | undefined;
  if (tabId) {
    tab = await chrome.tabs.get(tabId).catch(() => undefined);
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  }

  if (!tab || !tab.id || !tab.windowId) {
    return { ok: false, error: 'No active tab found.' };
  }

  if (!isCapturableUrl(tab.url)) {
    return { ok: false, error: 'This URL cannot be captured by Chrome extension policy.' };
  }
  const captureOptions = await loadCaptureOptions();

  const job: ActiveJob = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    filename: sanitizeFilename(),
    usesPreflight: captureOptions.enableSmartScroll,
    timeoutId: null
  };
  activeJob = job;
  armActiveJobTimeout(
    job.id,
    JOB_TIMEOUT_MS,
    `Capture timed out after ${Math.round(JOB_TIMEOUT_MS / 1000)}s.`
  );

  updateStatus({
    state: 'running',
    progress: 0,
    startedAt: Date.now(),
    pageUrl: tab.url,
    splitCount: 1,
    downloadedCount: 0,
    totalCount: 0,
    phase: captureOptions.enableSmartScroll ? 'preflight' : 'capture',
    phaseProgress: 0,
    phaseDetail: captureOptions.enableSmartScroll ? 'Preflight pass 0.' : undefined,
    error: undefined,
    notice: undefined
  });

  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: 'offscreen-reset', jobId: job.id });
    await ensureContentScriptInjected(tab.id);

    const contentScriptStartResponse = (await chrome.tabs.sendMessage(tab.id, {
      type: 'start-capture',
      jobId: job.id,
      options: captureOptions
    })) as RuntimeResponse;

    if (!contentScriptStartResponse.ok) {
      throw new Error(contentScriptStartResponse.error || 'Content script rejected capture start.');
    }
  } catch (error) {
    await failActiveJob(`Unable to start capture: ${getErrorMessage(error)}`);
    return { ok: false, error: 'Unable to initialize capture pipeline.' };
  }

  return { ok: true, data: { status, alreadyRunning: false } };
}

async function handlePreflightProgress(
  message: Extract<RuntimeMessage, { type: 'capture-preflight-progress' }>
): Promise<RuntimeResponse> {
  if (
    !activeJob ||
    message.jobId !== activeJob.id ||
    status.state !== 'running' ||
    !activeJob.usesPreflight
  ) {
    return { ok: true };
  }

  const phaseProgress = clamp(message.progress);
  const pass = Math.max(0, Math.floor(message.pass));
  const maxPasses = Math.max(1, Math.floor(message.maxPasses));
  const elapsedMs = Math.max(0, Math.floor(message.elapsedMs));
  const maxDurationMs = Math.max(1000, Math.floor(message.maxDurationMs));

  const detail =
    message.detail?.trim() ||
    `Preflight pass ${Math.min(pass, maxPasses)}/${maxPasses} - ${formatSeconds(elapsedMs)}/${formatSeconds(maxDurationMs)}.`;

  const notice =
    message.limitReason === 'pass'
      ? `Smart-scroll preflight reached pass cap (${maxPasses}). Capture continues with bounded height.`
      : message.limitReason === 'time'
        ? `Smart-scroll preflight reached time cap (${formatSeconds(maxDurationMs)}). Capture continues with bounded height.`
        : status.notice;

  updateStatus({
    phase: 'preflight',
    phaseProgress,
    phaseDetail: detail,
    progress: Math.min(PREFLIGHT_PROGRESS_WEIGHT, phaseProgress * PREFLIGHT_PROGRESS_WEIGHT),
    notice
  });

  return { ok: true };
}

async function handleCaptureTile(
  message: Extract<RuntimeMessage, { type: 'capture-tile' }>
): Promise<RuntimeResponse> {
  const job = activeJob;
  if (!job || message.jobId !== job.id || status.state !== 'running') {
    return { ok: false, error: 'Capture job is not active.' };
  }
  const tileValidationError = validateTilePayload(message.tile);
  if (tileValidationError) {
    await failActiveJob(`Invalid capture tile payload: ${tileValidationError}`);
    return { ok: false, error: 'Invalid capture tile payload.' };
  }

  try {
    const dataUrl = await captureVisibleTabWithRetry(job.windowId);
    if (!activeJob || activeJob.id !== job.id || status.state !== 'running') {
      return { ok: false, error: 'Capture job is no longer active.' };
    }

    const offscreenResponse = (await chrome.runtime.sendMessage({
      type: 'offscreen-add-tile',
      jobId: job.id,
      tile: message.tile,
      dataUrl
    })) as RuntimeResponse<OffscreenAddTileResponse>;

    if (!offscreenResponse.ok) {
      throw new Error(offscreenResponse.error);
    }

    const tileProgress = clamp(message.tile.complete);
    updateStatus({
      progress: activeJob.usesPreflight
        ? PREFLIGHT_PROGRESS_WEIGHT + tileProgress * (1 - PREFLIGHT_PROGRESS_WEIGHT)
        : tileProgress,
      splitCount: offscreenResponse.data?.splitCount ?? status.splitCount,
      phase: 'capture',
      phaseProgress: tileProgress,
      phaseDetail: undefined
    });

    return { ok: true };
  } catch (error) {
    await failActiveJob(`Capture failed: ${getErrorMessage(error)}`);
    return { ok: false, error: 'Tile capture failed.' };
  }
}

async function handleCaptureFinished(
  message: Extract<RuntimeMessage, { type: 'capture-finished' }>
): Promise<RuntimeResponse> {
  if (finalizingJobId === message.jobId) {
    return { ok: true };
  }

  const job = activeJob;
  if (!job || message.jobId !== job.id || status.state !== 'running') {
    return { ok: false, error: 'Capture job is not active.' };
  }

  finalizingJobId = job.id;
  try {
    armActiveJobTimeout(
      job.id,
      EXPORT_TIMEOUT_MS,
      `Export timed out after ${Math.round(EXPORT_TIMEOUT_MS / 1000)}s.`
    );

    updateStatus({
      phase: 'export',
      phaseProgress: 0,
      phaseDetail: 'Compositing and preparing files...'
    });

    const exportOptions = await loadExportOptions();

    const exported = (await chrome.runtime.sendMessage({
      type: 'offscreen-export',
      jobId: job.id,
      options: exportOptions,
      metadata: {
        pageUrl: status.pageUrl ?? '',
        capturedAtIso: new Date().toISOString()
      }
    })) as RuntimeResponse<OffscreenExportResponse>;

    if (!exported.ok) {
      throw new Error(exported.error);
    }

    const captures = exported.data?.captures ?? [];
    if (!captures.length) {
      throw new Error('No screenshots were generated.');
    }
    updateStatus({
      totalCount: captures.length,
      splitCount: captures.length,
      progress: 1
    });

    for (let i = 0; i < captures.length; i += 1) {
      const item = captures[i];
      const downloadId = await chrome.downloads.download({
        url: item.dataUrl,
        filename: addFilenameSuffix(job.filename, i, item.extension, captures.length),
        conflictAction: 'uniquify'
      });
      if (typeof downloadId !== 'number') {
        throw new Error(`Download ${i + 1}/${captures.length} did not start.`);
      }
      await waitForDownloadCompletion(downloadId);
      updateStatus({
        downloadedCount: i + 1,
        phase: 'export',
        phaseProgress: (i + 1) / captures.length,
        phaseDetail: `Downloading ${i + 1}/${captures.length}...`
      });
    }

    await chrome.runtime.sendMessage({ type: 'offscreen-clear', jobId: job.id });
    clearActiveJobTimeout();
    if (activeJob?.id === job.id) {
      activeJob = null;
    }
    scheduleOffscreenClose();
    updateStatus({
      state: 'done',
      phase: undefined,
      phaseProgress: undefined,
      phaseDetail: undefined
    });
    return { ok: true };
  } catch (error) {
    await failActiveJob(`Export failed: ${getErrorMessage(error)}`);
    return { ok: false, error: 'Unable to export image.' };
  } finally {
    if (finalizingJobId === job.id) {
      finalizingJobId = null;
    }
  }
}

async function handleCaptureFailure(
  message: Extract<RuntimeMessage, { type: 'capture-failed' }>
): Promise<RuntimeResponse> {
  if (finalizingJobId === message.jobId) {
    return { ok: true };
  }
  if (!activeJob || message.jobId !== activeJob.id || status.state !== 'running') {
    return { ok: true };
  }
  await failActiveJob(message.error || 'Capture stopped unexpectedly.');
  return { ok: true };
}

type CaptureJobMessage = Extract<
  RuntimeMessage,
  { type: 'capture-preflight-progress' | 'capture-tile' | 'capture-finished' | 'capture-failed' }
>;

function isCaptureJobMessage(message: RuntimeMessage): message is CaptureJobMessage {
  return (
    message.type === 'capture-preflight-progress' ||
    message.type === 'capture-tile' ||
    message.type === 'capture-finished' ||
    message.type === 'capture-failed'
  );
}

function isTrustedSender(message: RuntimeMessage, sender: chrome.runtime.MessageSender): boolean {
  // Reject messages from other extensions/external contexts.
  if (sender.id && sender.id !== chrome.runtime.id) {
    return false;
  }

  // Capture job messages must come from the active content-script tab and current job.
  if (isCaptureJobMessage(message)) {
    if (!activeJob) {
      return false;
    }
    if (!sender.tab?.id || sender.tab.id !== activeJob.tabId) {
      return false;
    }
    if (message.jobId !== activeJob.id) {
      return false;
    }
  }

  return true;
}

if (__DEV_MODE__) {
  void ensureDevReloadAlarm();
  void checkForDevBuildUpdate();

  chrome.runtime.onInstalled.addListener(() => {
    void ensureDevReloadAlarm();
    void checkForDevBuildUpdate();
  });

  chrome.runtime.onStartup.addListener(() => {
    void ensureDevReloadAlarm();
    void checkForDevBuildUpdate();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DEV_RELOAD_ALARM) {
      void checkForDevBuildUpdate();
    }
  });
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }
  if (!isTrustedSender(message, sender)) {
    sendResponse({ ok: false, error: 'Rejected message from untrusted sender.' });
    return false;
  }

  switch (message.type) {
    case 'start-capture':
      void startCapture()
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    case 'start-area-capture':
      void startAreaCapture()
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    case 'start-capture-target':
      void startCaptureForTab(message.tabId)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    case 'get-capture-status':
      sendResponse({
        ok: true,
        data: { status }
      } satisfies RuntimeResponse<{ status: CaptureStatus }>);
      return false;

    case 'capture-preflight-progress':
      void handlePreflightProgress(message)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    case 'capture-tile':
      void handleCaptureTile(message)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    case 'capture-finished':
      void handleCaptureFinished(message)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    case 'capture-failed':
      void handleCaptureFailure(message)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) }));
      return true;

    default:
      return false;
  }
});
