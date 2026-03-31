import type { CaptureOptions, CaptureTilePayload, RuntimeResponse } from '../shared/messages';
import { buildCapturePlan, safeMax } from '../shared/capture-math';

declare const __BUILD_ID__: string;

(function () {
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

  const SCROLL_PAD = 200;
  const PRE_FLIGHT_STABLE_PASSES = 2;
  const PRE_FLIGHT_MAX_PASSES = 24;
  const PRE_FLIGHT_MAX_DURATION_MS = 20_000;
  const MIN_SELECTION_SIZE_PX = 8;
  const OVERLAY_Z_INDEX = 10_000_000;
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
    viewportWidth: number;
    viewportHeight: number;
    screenshotWidth: number;
    screenshotHeight: number;
    cropX: number;
    cropY: number;
    cropWidth: number;
    cropHeight: number;
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

  interface ScrollRootTarget {
    kind: 'document' | 'element';
    element: HTMLElement | null;
    getScrollLeft(): number;
    getScrollTop(): number;
    scrollTo(x: number, y: number): void;
    readMetrics(): PageMetrics;
  }

  // Atomic lock for capture state to prevent race conditions
  let captureLock = false;

  function tryAcquireCaptureLock(): boolean {
    if (captureLock) return false;
    captureLock = true;
    return true;
  }

  function releaseCaptureLock(): void {
    captureLock = false;
  }

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

  function readDocumentMetrics(): PageMetrics {
    const body = document.body;
    const doc = document.documentElement;

    const totalWidth = Math.max(
      1,
      safeMax([
        doc.clientWidth,
        body?.scrollWidth ?? 0,
        doc.scrollWidth,
        body?.offsetWidth ?? 0,
        doc.offsetWidth
      ])
    );
    const totalHeight = Math.max(
      1,
      safeMax([
        doc.clientHeight,
        body?.scrollHeight ?? 0,
        doc.scrollHeight,
        body?.offsetHeight ?? 0,
        doc.offsetHeight
      ])
    );

    return {
      totalWidth,
      totalHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenshotWidth: window.innerWidth,
      screenshotHeight: window.innerHeight,
      cropX: 0,
      cropY: 0,
      cropWidth: window.innerWidth,
      cropHeight: window.innerHeight
    };
  }

  function computeVisibleRect(rect: DOMRect): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = right - x;
    const height = bottom - y;
    return {
      x,
      y,
      width: width > 0 ? width : 0,
      height: height > 0 ? height : 0
    };
  }

  function createDocumentScrollRoot(): ScrollRootTarget {
    return {
      kind: 'document',
      element: null,
      getScrollLeft: () => window.scrollX,
      getScrollTop: () => window.scrollY,
      scrollTo: (x, y) => window.scrollTo(x, y),
      readMetrics: () => readDocumentMetrics()
    };
  }

  function createElementScrollRoot(element: HTMLElement): ScrollRootTarget {
    return {
      kind: 'element',
      element,
      getScrollLeft: () => element.scrollLeft,
      getScrollTop: () => element.scrollTop,
      scrollTo: (x, y) => element.scrollTo(x, y),
      readMetrics: () => {
        const rect = element.getBoundingClientRect();
        const visible = computeVisibleRect(rect);
        return {
          totalWidth: safeMax([element.clientWidth, element.scrollWidth]),
          totalHeight: safeMax([element.clientHeight, element.scrollHeight]),
          viewportWidth: visible.width,
          viewportHeight: visible.height,
          screenshotWidth: window.innerWidth,
          screenshotHeight: window.innerHeight,
          cropX: visible.x,
          cropY: visible.y,
          cropWidth: visible.width,
          cropHeight: visible.height
        };
      }
    };
  }

  function findDominantScrollableElement(): HTMLElement | null {
    const body = document.body;
    if (!body) {
      return null;
    }

    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    let bestElement: HTMLElement | null = null;
    let bestScore = 0;

    const MIN_VISIBLE_FRACTION = 0.35;
    const MAX_SCROLL_RANGE_SCORE = 4;
    const MAX_WIDTH_RATIO_SCORE = 1;
    const MIN_SCROLL_RANGE_PX = 240;
    const MIN_ELEMENT_HEIGHT_PX = 220;

    const candidateSelectors = [
      'div[style*="overflow"]',
      'section[style*="overflow"]',
      'main[style*="overflow"]',
      'article[style*="overflow"]',
      'aside[style*="overflow"]',
      '[class*="scroll"]',
      '[class*="overflow"]',
      '[class*="container"]',
      '[class*="content"]',
      '[class*="wrapper"]',
      '[class*="viewport"]'
    ];

    const candidates = new Set<HTMLElement>();
    candidateSelectors.forEach((selector) => {
      try {
        body.querySelectorAll<HTMLElement>(selector).forEach((el) => {
          if (el.isConnected) candidates.add(el);
        });
      } catch {}
    });

    if (candidates.size < 20) {
      body.querySelectorAll<HTMLElement>('div, section, main, article, aside').forEach((el) => {
        if (el.isConnected) candidates.add(el);
      });
    }

    candidates.forEach((element) => {
      if (!element.isConnected) {
        return;
      }

      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflow = style.overflow;
      if (!/(auto|scroll|overlay)/.test(overflowY) && !/(auto|scroll|overlay)/.test(overflow)) {
        return;
      }
      if (style.position === 'fixed') {
        return;
      }

      const scrollRange = element.scrollHeight - element.clientHeight;
      if (scrollRange < MIN_SCROLL_RANGE_PX || element.clientHeight < MIN_ELEMENT_HEIGHT_PX) {
        return;
      }

      const rect = element.getBoundingClientRect();
      const visible = computeVisibleRect(rect);
      if (
        visible.width < window.innerWidth * MIN_VISIBLE_FRACTION ||
        visible.height < window.innerHeight * MIN_VISIBLE_FRACTION
      ) {
        return;
      }

      const visibleArea = visible.width * visible.height;
      const score =
        visibleArea / viewportArea +
        Math.min(MAX_SCROLL_RANGE_SCORE, scrollRange / Math.max(1, element.clientHeight)) +
        Math.min(MAX_WIDTH_RATIO_SCORE, element.clientWidth / Math.max(1, window.innerWidth));

      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    });

    return bestElement;
  }

  function resolveScrollRoot(): ScrollRootTarget {
    const documentRoot = createDocumentScrollRoot();
    const metrics = documentRoot.readMetrics();
    const documentScrollRange = metrics.totalHeight - metrics.viewportHeight;
    if (documentScrollRange > 120) {
      return documentRoot;
    }

    const candidate = findDominantScrollableElement();
    return candidate ? createElementScrollRoot(candidate) : documentRoot;
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

  function preparePage(scrollRoot: ScrollRootTarget): () => void {
    const body = document.body;
    const doc = document.documentElement;
    const original = {
      x: window.scrollX,
      y: window.scrollY,
      rootX: scrollRoot.getScrollLeft(),
      rootY: scrollRoot.getScrollTop(),
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
      'header',
      'footer',
      'nav',
      '[style*="position"]',
      '[class*="fixed"]',
      '[class*="sticky"]',
      '[class*="header"]',
      '[class*="navbar"]',
      '[class*="toolbar"]',
      '[class*="sidebar"]',
      '[class*="menu"]'
    ];

    const candidateElements = new Set<HTMLElement>();

    // First pass: collect candidates from semantic elements and class hints
    candidateSelectors.forEach((selector) => {
      document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        candidateElements.add(el);
      });
    });

    // Second pass: only check direct body children if candidate set is small
    if (candidateElements.size < 50) {
      document.querySelectorAll<HTMLElement>('body > *').forEach((el) => {
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
      '*,::before,::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}';
    doc.appendChild(animationStyle);

    return () => {
      try {
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
        if (scrollRoot.element?.isConnected) {
          scrollRoot.scrollTo(original.rootX, original.rootY);
        }
        window.scrollTo(original.x, original.y);
      } catch {}
    };
  }

  async function estimateSmartHeight(
    scrollRoot: ScrollRootTarget,
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

      const targetY = Math.max(0, estimatedHeight - initialMetrics.viewportHeight);
      scrollRoot.scrollTo(0, targetY);
      await waitForSettledFrame(options);
      passCount += 1;

      const now = scrollRoot.readMetrics();
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
    scrollRoot: ScrollRootTarget,
    jobId: string,
    jobStartedAt: number,
    metrics: PageMetrics,
    options: CaptureOptions
  ): Promise<void> {
    const plan = buildCapturePlan(
      metrics.totalWidth,
      metrics.totalHeight,
      metrics.viewportWidth,
      metrics.viewportHeight,
      SCROLL_PAD
    );
    const totalSteps = plan.length;

    for (let index = 0; index < totalSteps; index += 1) {
      ensureWithinTimeout(jobStartedAt, 'tile capture');
      const [x, y] = plan[index];
      scrollRoot.scrollTo(x, y);
      await waitForSettledFrame(options);

      // Verify actual scroll position matches intended position
      const actualX = scrollRoot.getScrollLeft();
      const actualY = scrollRoot.getScrollTop();
      const scrollDeltaX = Math.abs(actualX - x);
      const scrollDeltaY = Math.abs(actualY - y);

      // If scroll position is significantly off, re-scroll with retry limit
      let scrollAttempts = 1;
      const MAX_SCROLL_ATTEMPTS = 3;

      while ((scrollDeltaX > 2 || scrollDeltaY > 2) && scrollAttempts < MAX_SCROLL_ATTEMPTS) {
        console.warn(
          `[ContentScript] Scroll position mismatch: intended (${x}, ${y}), actual (${actualX}, ${actualY}). Re-scrolling... (attempt ${scrollAttempts}/${MAX_SCROLL_ATTEMPTS})`
        );
        scrollRoot.scrollTo(x, y);
        await waitForSettledFrame(options);
        scrollAttempts++;
      }

      const currentMetrics = scrollRoot.readMetrics();

      const payload: CaptureTilePayload = {
        x: scrollRoot.getScrollLeft(),
        y: scrollRoot.getScrollTop(),
        complete: (index + 1) / totalSteps,
        viewportWidth: currentMetrics.viewportWidth,
        viewportHeight: currentMetrics.viewportHeight,
        screenshotWidth: currentMetrics.screenshotWidth,
        screenshotHeight: currentMetrics.screenshotHeight,
        cropX: currentMetrics.cropX,
        cropY: currentMetrics.cropY,
        cropWidth: currentMetrics.cropWidth,
        cropHeight: currentMetrics.cropHeight,
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
    const scrollRoot = resolveScrollRoot();
    const restore = preparePage(scrollRoot);
    const jobStartedAt = Date.now();

    try {
      let metrics = scrollRoot.readMetrics();
      if (options.enableSmartScroll) {
        const estimated = await estimateSmartHeight(
          scrollRoot,
          jobId,
          jobStartedAt,
          metrics,
          options
        );
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
      scrollRoot.scrollTo(0, 0);
      if (scrollRoot.kind === 'element') {
        window.scrollTo(0, 0);
      }
      await waitForSettledFrame(options);
      await captureAllTiles(scrollRoot, jobId, jobStartedAt, metrics, options);

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
    sender: chrome.runtime.MessageSender,
    sendResponse: (
      response: RuntimeResponse<
        { ready?: true; capturing?: boolean; buildId?: string } | VisibleAreaSelection
      >
    ) => void
  ): boolean {
    if (sender.id !== chrome.runtime.id) {
      return false;
    }
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return false;
    }

    if (message.type === 'capture-ping') {
      sendResponse({
        ok: true,
        data: { ready: true, capturing: captureLock, buildId: __BUILD_ID__ }
      });
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

    if (!tryAcquireCaptureLock()) {
      sendResponse({ ok: false, error: 'Capture already in progress.' } satisfies RuntimeResponse);
      return false;
    }

    sendResponse({ ok: true } satisfies RuntimeResponse);

    const options = normalizeOptions(message.options);
    void runCapture(message.jobId, options).finally(() => {
      releaseCaptureLock();
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
      overlay.style.cssText = `position:fixed;inset:0;z-index:${OVERLAY_Z_INDEX};cursor:crosshair;user-select:none;touch-action:none;background:rgba(0,0,0,0.12);`;
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
        if (rect.width < MIN_SELECTION_SIZE_PX || rect.height < MIN_SELECTION_SIZE_PX) {
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
})();
