import type { CaptureOptions, CaptureTilePayload, RuntimeResponse } from '../shared/messages';
import { buildCapturePlan, safeMax } from '../shared/capture-math';

// These constants are intentionally duplicated from shared/constants.ts.
// The content script is injected via chrome.scripting.executeScript({files:[...]})
// which requires a self-contained classic-script bundle with no ES module imports.
// Rollup would split shared/constants.ts into a separate chunk (because other
// entry points also import it), adding an `import` statement that breaks injection.
const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  enableSmartScroll: true,
  lazyLoadWaitMs: 180,
  settleFrames: 2,
  heightGrowthThresholdPx: 48,
  maxExtraHeightPx: 30000,
  maxCaptureHeightPx: 80000
};
const JOB_TIMEOUT_MS = 180_000;

declare const __BUILD_ID__: string;

const SCROLL_PAD = 200;
const PRE_FLIGHT_STABLE_PASSES = 2;
const PRE_FLIGHT_MAX_PASSES = 24;
const PRE_FLIGHT_MAX_DURATION_MS = 20_000;
const CONTENT_LISTENER_KEY = '__emeraldpixListenerInstalled__';
const RUNTIME_LISTENER_KEY = '__emeraldpixRuntimeListener__';
const LISTENER_BUILD_ID_KEY = '__emeraldpixListenerBuildId__';

interface StartMessage {
  type: 'start-capture';
  jobId: string;
  options?: Partial<CaptureOptions>;
}

interface SelectAreaMessage {
  type: 'select-area';
}

interface PingMessage {
  type: 'capture-ping';
}

type ContentMessage = StartMessage | PingMessage | SelectAreaMessage;

interface PageMetrics {
  totalWidth: number;
  totalHeight: number;
  windowWidth: number;
  windowHeight: number;
}

interface RestorableLazyElement {
  element: HTMLImageElement | HTMLIFrameElement;
  hadLoadingAttribute: boolean;
  loadingValue: string | null;
}

type PreflightLimitReason = 'pass' | 'time';

interface SmartHeightEstimate {
  finalHeight: number;
  maxWidth: number;
  limitReason?: PreflightLimitReason;
}

interface VisibleAreaSelection {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

let isCapturing = false;

function normalizeOptions(input?: Partial<CaptureOptions>): CaptureOptions {
  const merged = { ...DEFAULT_CAPTURE_OPTIONS, ...(input ?? {}) };
  return {
    enableSmartScroll: Boolean(merged.enableSmartScroll),
    lazyLoadWaitMs: Math.max(50, Math.min(1500, Math.floor(merged.lazyLoadWaitMs))),
    settleFrames: Math.max(1, Math.min(6, Math.floor(merged.settleFrames))),
    heightGrowthThresholdPx: Math.max(8, Math.floor(merged.heightGrowthThresholdPx)),
    maxExtraHeightPx: Math.max(0, Math.floor(merged.maxExtraHeightPx)),
    maxCaptureHeightPx: Math.max(2000, Math.floor(merged.maxCaptureHeightPx))
  };
}

function readPageMetrics(): PageMetrics {
  const body = document.body;
  const doc = document.documentElement;

  const totalWidth = safeMax([
    doc.clientWidth,
    body?.scrollWidth ?? 0,
    doc.scrollWidth,
    body?.offsetWidth ?? 0,
    doc.offsetWidth
  ]);
  const totalHeight = safeMax([
    doc.clientHeight,
    body?.scrollHeight ?? 0,
    doc.scrollHeight,
    body?.offsetHeight ?? 0,
    doc.offsetHeight
  ]);

  return {
    totalWidth,
    totalHeight,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForSettledFrame(options: CaptureOptions): Promise<void> {
  for (let i = 0; i < options.settleFrames; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await delay(options.lazyLoadWaitMs);
}

async function sendMessage<T>(message: unknown): Promise<RuntimeResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
}

function ensureWithinTimeout(jobStartedAt: number, phase: string): void {
  const elapsedMs = Date.now() - jobStartedAt;
  if (elapsedMs > JOB_TIMEOUT_MS) {
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    throw new Error(`Capture timed out during ${phase} after ${elapsedSeconds}s.`);
  }
}

async function reportPreflightProgress(
  jobId: string,
  payload: {
    progress: number;
    pass: number;
    elapsedMs: number;
    limitReason?: PreflightLimitReason;
    detail?: string;
  }
): Promise<void> {
  try {
    await sendMessage({
      type: 'capture-preflight-progress',
      jobId,
      progress: payload.progress,
      pass: payload.pass,
      maxPasses: PRE_FLIGHT_MAX_PASSES,
      elapsedMs: payload.elapsedMs,
      maxDurationMs: PRE_FLIGHT_MAX_DURATION_MS,
      limitReason: payload.limitReason,
      detail: payload.detail
    });
  } catch {
    // Best-effort status signal for popup; capture must continue if telemetry fails.
  }
}

function preparePage(): () => void {
  const body = document.body;
  const doc = document.documentElement;
  const original = {
    x: window.scrollX,
    y: window.scrollY,
    bodyOverflowY: body?.style.overflowY ?? '',
    docOverflow: doc.style.overflow
  };

  if (body) {
    body.style.overflowY = 'visible';
  }
  doc.style.overflow = 'hidden';

  const hiddenFixedElements: Array<{
    element: HTMLElement;
    visibility: string;
    pointerEvents: string;
  }> = [];

  // Performance optimization: only scan direct children and elements likely to be fixed/sticky
  // This avoids expensive getComputedStyle calls on entire DOM tree
  const viewportHeight = window.innerHeight;
  const candidateSelectors = [
    'header', 'footer', 'nav',
    '[style*="position"]',
    '[class*="fixed"]', '[class*="sticky"]', '[class*="header"]', '[class*="navbar"]',
    '[class*="toolbar"]', '[class*="sidebar"]', '[class*="menu"]'
  ];

  const candidateElements = new Set<HTMLElement>();

  // First pass: collect candidates from semantic elements and class hints
  candidateSelectors.forEach(selector => {
    document.querySelectorAll<HTMLElement>(selector).forEach(el => {
      candidateElements.add(el);
    });
  });

  // Second pass: only check direct body children if candidate set is small
  if (candidateElements.size < 50) {
    document.querySelectorAll<HTMLElement>('body > *').forEach(el => {
      const rect = el.getBoundingClientRect();
      // Only check elements that are in the viewport
      if (rect.bottom >= 0 && rect.top <= viewportHeight) {
        candidateElements.add(el);
      }
    });
  }

  // Check computed styles only for candidates
  candidateElements.forEach((element) => {
    const computed = window.getComputedStyle(element);
    if (computed.position === 'fixed' || computed.position === 'sticky') {
      hiddenFixedElements.push({
        element,
        visibility: element.style.visibility,
        pointerEvents: element.style.pointerEvents
      });
      element.style.setProperty('visibility', 'hidden', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
    }
  });

  const lazyElements: RestorableLazyElement[] = [];
  document
    .querySelectorAll<HTMLImageElement | HTMLIFrameElement>('img[loading], iframe[loading]')
    .forEach((element) => {
      lazyElements.push({
        element,
        hadLoadingAttribute: element.hasAttribute('loading'),
        loadingValue: element.getAttribute('loading')
      });
      element.setAttribute('loading', 'eager');
    });

  const animationStyle = document.createElement('style');
  animationStyle.id = '__emeraldpix_pause_animations__';
  animationStyle.textContent =
    '*,:before,:after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}';
  doc.appendChild(animationStyle);

  return () => {
    doc.style.overflow = original.docOverflow;
    if (body) {
      body.style.overflowY = original.bodyOverflowY;
    }
    hiddenFixedElements.forEach((entry) => {
      entry.element.style.visibility = entry.visibility;
      entry.element.style.pointerEvents = entry.pointerEvents;
    });
    lazyElements.forEach((entry) => {
      if (entry.hadLoadingAttribute) {
        entry.element.setAttribute('loading', entry.loadingValue ?? 'lazy');
      } else {
        entry.element.removeAttribute('loading');
      }
    });
    animationStyle.remove();
    window.scrollTo(original.x, original.y);
  };
}

async function estimateSmartHeight(
  jobId: string,
  jobStartedAt: number,
  initialMetrics: PageMetrics,
  options: CaptureOptions
): Promise<SmartHeightEstimate> {
  const maxAllowedByGrowth = Math.min(
    options.maxCaptureHeightPx,
    initialMetrics.totalHeight + options.maxExtraHeightPx
  );
  let estimatedHeight = Math.min(initialMetrics.totalHeight, maxAllowedByGrowth);
  let maxWidth = initialMetrics.totalWidth;
  let stablePasses = 0;
  let passCount = 0;
  let limitReason: PreflightLimitReason | undefined;
  const preflightStartedAt = Date.now();

  await reportPreflightProgress(jobId, {
    progress: 0,
    pass: 0,
    elapsedMs: 0
  });

  while (stablePasses < PRE_FLIGHT_STABLE_PASSES) {
    ensureWithinTimeout(jobStartedAt, 'smart-scroll preflight');

    const elapsedBeforePassMs = Date.now() - preflightStartedAt;
    if (passCount >= PRE_FLIGHT_MAX_PASSES) {
      limitReason = 'pass';
      break;
    }
    if (elapsedBeforePassMs >= PRE_FLIGHT_MAX_DURATION_MS) {
      limitReason = 'time';
      break;
    }

    const targetY = Math.max(0, estimatedHeight - initialMetrics.windowHeight);
    window.scrollTo(0, targetY);
    await waitForSettledFrame(options);
    passCount += 1;

    const now = readPageMetrics();
    maxWidth = Math.max(maxWidth, now.totalWidth);
    const boundedHeight = Math.min(now.totalHeight, maxAllowedByGrowth);

    if (boundedHeight > estimatedHeight + options.heightGrowthThresholdPx) {
      estimatedHeight = boundedHeight;
      stablePasses = 0;
    } else {
      stablePasses += 1;
    }

    const elapsedMs = Date.now() - preflightStartedAt;
    const progress = Math.min(
      0.99,
      Math.max(passCount / PRE_FLIGHT_MAX_PASSES, elapsedMs / PRE_FLIGHT_MAX_DURATION_MS)
    );
    await reportPreflightProgress(jobId, {
      progress,
      pass: passCount,
      elapsedMs
    });
  }

  const finalElapsedMs = Date.now() - preflightStartedAt;
  const finalDetail =
    limitReason === 'pass'
      ? `Smart-scroll preflight capped at ${PRE_FLIGHT_MAX_PASSES} passes.`
      : limitReason === 'time'
        ? `Smart-scroll preflight capped at ${Math.round(PRE_FLIGHT_MAX_DURATION_MS / 1000)}s.`
        : undefined;
  await reportPreflightProgress(jobId, {
    progress: 1,
    pass: passCount,
    elapsedMs: finalElapsedMs,
    limitReason,
    detail: finalDetail
  });

  return {
    finalHeight: estimatedHeight,
    maxWidth,
    limitReason
  };
}

async function captureAllTiles(
  jobId: string,
  jobStartedAt: number,
  metrics: { totalWidth: number; totalHeight: number; windowWidth: number; windowHeight: number },
  options: CaptureOptions
): Promise<void> {
  const plan = buildCapturePlan(
    metrics.totalWidth,
    metrics.totalHeight,
    metrics.windowWidth,
    metrics.windowHeight,
    SCROLL_PAD
  );
  const totalSteps = plan.length;

  for (let index = 0; index < totalSteps; index += 1) {
    ensureWithinTimeout(jobStartedAt, 'tile capture');
    const [x, y] = plan[index];
    window.scrollTo(x, y);
    await waitForSettledFrame(options);

    const payload: CaptureTilePayload = {
      x: window.scrollX,
      y: window.scrollY,
      complete: (index + 1) / totalSteps,
      windowWidth: metrics.windowWidth,
      windowHeight: metrics.windowHeight,
      totalWidth: metrics.totalWidth,
      totalHeight: metrics.totalHeight,
      devicePixelRatio: window.devicePixelRatio
    };

    const tileResponse = await sendMessage({
      type: 'capture-tile',
      jobId,
      tile: payload
    });
    if (!tileResponse.ok) {
      throw new Error(tileResponse.error || 'Tile capture failed.');
    }
  }
}

async function runCapture(jobId: string, options: CaptureOptions): Promise<void> {
  const restore = preparePage();
  const jobStartedAt = Date.now();

  try {
    let metrics = readPageMetrics();
    if (options.enableSmartScroll) {
      const estimated = await estimateSmartHeight(jobId, jobStartedAt, metrics, options);
      metrics = {
        ...metrics,
        totalWidth: Math.max(metrics.totalWidth, estimated.maxWidth),
        totalHeight: estimated.finalHeight
      };
    } else {
      metrics = {
        ...metrics,
        totalHeight: Math.min(metrics.totalHeight, options.maxCaptureHeightPx)
      };
    }

    ensureWithinTimeout(jobStartedAt, 'initialization');
    window.scrollTo(0, 0);
    await waitForSettledFrame(options);
    await captureAllTiles(jobId, jobStartedAt, metrics, options);

    ensureWithinTimeout(jobStartedAt, 'export preparation');
    const finishResponse = await sendMessage({
      type: 'capture-finished',
      jobId
    });
    if (!finishResponse.ok) {
      throw new Error(finishResponse.error || 'Failed to export capture.');
    }
  } catch (error) {
    await sendMessage({
      type: 'capture-failed',
      jobId,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    restore();
  }
}

function handleRuntimeMessage(
  message: ContentMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (
    response: RuntimeResponse<
      { ready?: true; capturing?: boolean; buildId?: string } | VisibleAreaSelection
    >
  ) => void
): boolean {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }

  if (message.type === 'capture-ping') {
    sendResponse({ ok: true, data: { ready: true, capturing: isCapturing, buildId: __BUILD_ID__ } });
    return false;
  }

  if (message.type === 'select-area') {
    void requestVisibleAreaSelection()
      .then((selection) => sendResponse({ ok: true, data: selection }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies RuntimeResponse)
      );
    return true;
  }

  if (message.type !== 'start-capture' || !message.jobId) {
    return false;
  }

  if (isCapturing) {
    sendResponse({ ok: false, error: 'Capture already in progress.' } satisfies RuntimeResponse);
    return false;
  }

  isCapturing = true;
  sendResponse({ ok: true } satisfies RuntimeResponse);

  const options = normalizeOptions(message.options);
  void runCapture(message.jobId, options).finally(() => {
    isCapturing = false;
  });

  return false;
}

const globalScope = globalThis as typeof globalThis & {
  __emeraldpixListenerInstalled__?: boolean;
  __emeraldpixListenerBuildId__?: string;
  __emeraldpixRuntimeListener__?: typeof handleRuntimeMessage;
};

if (
  globalScope[CONTENT_LISTENER_KEY] &&
  globalScope[RUNTIME_LISTENER_KEY] &&
  globalScope[LISTENER_BUILD_ID_KEY] !== __BUILD_ID__
) {
  chrome.runtime.onMessage.removeListener(globalScope[RUNTIME_LISTENER_KEY]);
  globalScope[CONTENT_LISTENER_KEY] = false;
}

function requestVisibleAreaSelection(): Promise<VisibleAreaSelection> {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    const box = document.createElement('div');
    overlay.id = '__emeraldpix_area_overlay__';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;touch-action:none;background:rgba(0,0,0,0.12);';
    box.style.cssText =
      'position:absolute;border:2px solid #10b981;background:rgba(16,185,129,0.14);box-shadow:0 0 0 99999px rgba(0,0,0,0.24);display:none;';
    overlay.appendChild(box);
    document.documentElement.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const cleanup = () => {
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
    };

    const getRect = (clientX: number, clientY: number) => {
      const left = Math.max(0, Math.min(startX, clientX));
      const top = Math.max(0, Math.min(startY, clientY));
      const right = Math.min(window.innerWidth, Math.max(startX, clientX));
      const bottom = Math.min(window.innerHeight, Math.max(startY, clientY));
      return {
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      };
    };

    const paintRect = (clientX: number, clientY: number) => {
      const rect = getRect(clientX, clientY);
      box.style.display = 'block';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      overlay.setPointerCapture(event.pointerId);
      paintRect(event.clientX, event.clientY);
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      paintRect(event.clientX, event.clientY);
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      const rect = getRect(event.clientX, event.clientY);
      cleanup();
      if (rect.width < 8 || rect.height < 8) {
        reject(new Error('Area selection cancelled.'));
        return;
      }
      resolve({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cleanup();
        reject(new Error('Area selection cancelled.'));
      }
    };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown, true);
  });
}

if (!globalScope[CONTENT_LISTENER_KEY] || globalScope[LISTENER_BUILD_ID_KEY] !== __BUILD_ID__) {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  globalScope[RUNTIME_LISTENER_KEY] = handleRuntimeMessage;
  globalScope[LISTENER_BUILD_ID_KEY] = __BUILD_ID__;
  globalScope[CONTENT_LISTENER_KEY] = true;
}
