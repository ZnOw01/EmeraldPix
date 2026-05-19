import type {
	CaptureOptions,
	CaptureTilePayload,
	RuntimeResponse,
} from "../shared/messages";
import { buildCapturePlan, safeMax } from "../shared/capture-math";

// These constants are intentionally duplicated from shared/constants.ts.
// The content script is injected via chrome.scripting.executeScript({files:[...]})
// which requires a self-contained classic-script bundle with no ES module imports.
// Rollup would split shared/constants.ts into a separate chunk (because other
// entry points also import it), adding an import statement that breaks injection.
const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
	enableSmartScroll: true,
	lazyLoadWaitMs: 180,
	settleFrames: 2,
	heightGrowthThresholdPx: 48,
	maxExtraHeightPx: 30000,
	maxCaptureHeightPx: 80000,
};
const JOB_TIMEOUT_MS = 180_000;

const PRE_FLIGHT_STABLE_PASSES = 2;
const PRE_FLIGHT_MAX_PASSES = 24;
const PRE_FLIGHT_MAX_DURATION_MS = 20_000;

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

type PreflightLimitReason = "pass" | "time";

interface SmartHeightEstimate {
	finalHeight: number;
	maxWidth: number;
	limitReason?: PreflightLimitReason;
}

interface ScrollRootTarget {
	kind: "document" | "element";
	element: HTMLElement | null;
	getScrollLeft(): number;
	getScrollTop(): number;
	scrollTo(x: number, y: number): void;
	readMetrics(): PageMetrics;
}

// ---- Options ----

export function normalizeOptions(
	input?: Partial<CaptureOptions>,
): CaptureOptions {
	const merged = { ...DEFAULT_CAPTURE_OPTIONS, ...(input ?? {}) };
	return {
		enableSmartScroll: Boolean(merged.enableSmartScroll),
		lazyLoadWaitMs: Math.max(
			50,
			Math.min(1500, Math.floor(merged.lazyLoadWaitMs)),
		),
		settleFrames: Math.max(1, Math.min(6, Math.floor(merged.settleFrames))),
		heightGrowthThresholdPx: Math.max(
			8,
			Math.floor(merged.heightGrowthThresholdPx),
		),
		maxExtraHeightPx: Math.max(0, Math.floor(merged.maxExtraHeightPx)),
		maxCaptureHeightPx: Math.max(2000, Math.floor(merged.maxCaptureHeightPx)),
	};
}

// ---- Metrics ----

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
			doc.offsetWidth,
		]),
	);
	const totalHeight = Math.max(
		1,
		safeMax([
			doc.clientHeight,
			body?.scrollHeight ?? 0,
			doc.scrollHeight,
			body?.offsetHeight ?? 0,
			doc.offsetHeight,
		]),
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
		cropHeight: window.innerHeight,
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
		height: height > 0 ? height : 0,
	};
}

// ---- Scroll roots ----

function createDocumentScrollRoot(): ScrollRootTarget {
	return {
		kind: "document",
		element: null,
		getScrollLeft: () => window.scrollX,
		getScrollTop: () => window.scrollY,
		scrollTo: (x, y) => window.scrollTo(x, y),
		readMetrics: () => readDocumentMetrics(),
	};
}

function createElementScrollRoot(element: HTMLElement): ScrollRootTarget {
	return {
		kind: "element",
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
				cropHeight: visible.height,
			};
		},
	};
}

function* walkAllElements(root: Element | ShadowRoot): Generator<HTMLElement> {
	const walker = document.createTreeWalker(
		root,
		NodeFilter.SHOW_ELEMENT,
		null,
	);
	let node: Node | null = walker.currentNode;
	while (node) {
		if (node instanceof HTMLElement) {
			yield node;
			if (node.shadowRoot) {
				yield* walkAllElements(node.shadowRoot);
			}
		}
		node = walker.nextNode();
	}
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
		'[class*="viewport"]',
		'[role="main"]',
		'[role="grid"]',
		'[role="listbox"]',
		'[role="list"]',
		'main',
		'#canvas-container', // Common in some apps
		'.drive-container', // Specific for drive if classes are stable
	];

	const candidates = new Set<HTMLElement>();
	candidateSelectors.forEach((selector) => {
		try {
			body.querySelectorAll<HTMLElement>(selector).forEach((el) => {
				if (el.isConnected) candidates.add(el);
			});
		} catch {}
	});

	// Also search inside Shadow DOM roots
	for (const el of walkAllElements(document.documentElement)) {
		if (el.shadowRoot) {
			candidateSelectors.forEach((selector) => {
				try {
					el.shadowRoot!.querySelectorAll<HTMLElement>(selector).forEach(
						(child) => {
							if (child.isConnected) candidates.add(child);
						},
					);
				} catch {}
			});
		}
	}

	// Fallback to all divs if few candidates found, but with stricter scroll range check
	if (candidates.size < 20) {
		body
			.querySelectorAll<HTMLElement>("div, section, main, article, aside")
			.forEach((el) => {
				if (el.isConnected && (el.scrollHeight > el.clientHeight + MIN_SCROLL_RANGE_PX)) {
					candidates.add(el);
				}
			});
	}

	candidates.forEach((element) => {
		if (!element.isConnected) {
			return;
		}

		const style = window.getComputedStyle(element);
		const overflowY = style.overflowY;
		const overflow = style.overflow;
		
		// Some elements might have overflow:hidden but still be scrollable via JS (virtual scroll)
		// but usually they have auto/scroll/overlay.
		// For Google Drive, the container often has overflow: auto or hidden with a sub-container.
		const isScrollableStyle = /(auto|scroll|overlay)/.test(overflowY) || /(auto|scroll|overlay)/.test(overflow);
		
		if (!isScrollableStyle && element.scrollHeight <= element.clientHeight + 5) {
			return;
		}

		if (style.position === "fixed") {
			return;
		}

		const scrollRange = element.scrollHeight - element.clientHeight;
		if (
			scrollRange < MIN_SCROLL_RANGE_PX ||
			element.clientHeight < MIN_ELEMENT_HEIGHT_PX
		) {
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
			(visibleArea / viewportArea) * 2 + // Give more weight to visibility
			Math.min(
				MAX_SCROLL_RANGE_SCORE,
				scrollRange / Math.max(1, element.clientHeight),
			) +
			Math.min(
				MAX_WIDTH_RATIO_SCORE,
				element.clientWidth / Math.max(1, window.innerWidth),
			);

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

// ---- Timing ----

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function waitForSettledFrame(
	options: CaptureOptions,
): Promise<void> {
	for (let i = 0; i < options.settleFrames; i += 1) {
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	}
	await delay(options.lazyLoadWaitMs);
}

// ---- Messaging ----

async function sendMessage<T>(message: unknown): Promise<RuntimeResponse<T>> {
	return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
}

function ensureWithinTimeout(jobStartedAt: number, phase: string): void {
	const elapsedMs = Date.now() - jobStartedAt;
	if (elapsedMs > JOB_TIMEOUT_MS) {
		const elapsedSeconds = Math.round(elapsedMs / 1000);
		throw new Error(
			`Capture timed out during ${phase} after ${elapsedSeconds}s.`,
		);
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
	},
): Promise<void> {
	try {
		await sendMessage({
			type: "capture-preflight-progress",
			jobId,
			progress: payload.progress,
			pass: payload.pass,
			maxPasses: PRE_FLIGHT_MAX_PASSES,
			elapsedMs: payload.elapsedMs,
			maxDurationMs: PRE_FLIGHT_MAX_DURATION_MS,
			limitReason: payload.limitReason,
			detail: payload.detail,
		});
	} catch {
		// Best-effort status signal for popup; capture must continue if telemetry fails.
	}
}

// ---- Page preparation ----

interface StyleOverrideEntry {
	element: HTMLElement;
	property: string;
	value: string;
	priority: string;
}

function pushStyleOverride(
	stack: StyleOverrideEntry[],
	element: HTMLElement,
	property: string,
	newValue: string,
): void {
	stack.push({
		element,
		property,
		value: element.style.getPropertyValue(property),
		priority: element.style.getPropertyPriority(property),
	});
	element.style.setProperty(property, newValue, "important");
}

function restoreStyleOverrides(stack: StyleOverrideEntry[]): void {
	for (const entry of stack) {
		if (entry.value) {
			entry.element.style.setProperty(
				entry.property,
				entry.value,
				entry.priority,
			);
		} else {
			entry.element.style.removeProperty(entry.property);
		}
	}
	stack.length = 0;
}

export function preparePage(scrollRoot: ScrollRootTarget): () => void {
	const body = document.body;
	const doc = document.documentElement;
	const originalScroll = {
		x: window.scrollX,
		y: window.scrollY,
		rootX: scrollRoot.getScrollLeft(),
		rootY: scrollRoot.getScrollTop(),
	};

	const styleStack: StyleOverrideEntry[] = [];

	if (body) {
		pushStyleOverride(styleStack, body, "overflow-x", "hidden");
		pushStyleOverride(styleStack, body, "overflow-y", "hidden");
	}
	pushStyleOverride(styleStack, doc, "overflow-x", "hidden");
	pushStyleOverride(styleStack, doc, "overflow-y", "hidden");

	// Remove background-attachment: fixed to prevent parallax artifacts across tiles
	const parallaxElements: StyleOverrideEntry[] = [];
	try {
		document.querySelectorAll<HTMLElement>("*").forEach((el) => {
			const computed = window.getComputedStyle(el);
			if (computed.backgroundAttachment === "fixed") {
				pushStyleOverride(
					parallaxElements,
					el,
					"background-attachment",
					"scroll",
				);
			}
		});
	} catch {
		// Best-effort parallax removal
	}

	// Performance optimization: only scan direct children and elements likely to be fixed/sticky
	const viewportHeight = window.innerHeight;
	const candidateSelectors = [
		"header",
		"footer",
		"nav",
		'[style*="position"]',
		'[class*="fixed"]',
		'[class*="sticky"]',
		'[class*="header"]',
		'[class*="navbar"]',
		'[class*="toolbar"]',
		'[class*="sidebar"]',
		'[class*="menu"]',
	];

	const candidateElements = new Set<HTMLElement>();

	candidateSelectors.forEach((selector) => {
		document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
			candidateElements.add(el);
		});
	});

	if (candidateElements.size < 50) {
		document.querySelectorAll<HTMLElement>("body > *").forEach((el) => {
			const rect = el.getBoundingClientRect();
			if (rect.bottom >= 0 && rect.top <= viewportHeight) {
				candidateElements.add(el);
			}
		});
	}

	const fixedElementsStack: StyleOverrideEntry[] = [];

	candidateElements.forEach((element) => {
		const computed = window.getComputedStyle(element);
		if (computed.position === "fixed" || computed.position === "sticky") {
			// Use opacity:0 instead of visibility:hidden to avoid layout reflow
			// which would shift content between tiles and cause gaps.
			pushStyleOverride(fixedElementsStack, element, "opacity", "0");
			pushStyleOverride(fixedElementsStack, element, "animation", "none");
			pushStyleOverride(fixedElementsStack, element, "transition", "none");
			pushStyleOverride(fixedElementsStack, element, "pointer-events", "none");
		}
	});

	const lazyElements: RestorableLazyElement[] = [];
	const MAX_LAZY_ELEMENTS = 1000;
	const lazyNodeList = document.querySelectorAll<
		HTMLImageElement | HTMLIFrameElement
	>("img[loading], iframe[loading]");

	for (let i = 0; i < Math.min(lazyNodeList.length, MAX_LAZY_ELEMENTS); i++) {
		const element = lazyNodeList[i];
		lazyElements.push({
			element,
			hadLoadingAttribute: element.hasAttribute("loading"),
			loadingValue: element.getAttribute("loading"),
		});
		element.setAttribute("loading", "eager");
	}

	const animationStyle = document.createElement("style");
	animationStyle.id = "__emeraldpix_pause_animations__";
	animationStyle.textContent =
		"*,::before,::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;}";
	doc.appendChild(animationStyle);

	return () => {
		try {
			restoreStyleOverrides(styleStack);
			restoreStyleOverrides(fixedElementsStack);
			restoreStyleOverrides(parallaxElements);
			lazyElements.forEach((entry) => {
				if (entry.hadLoadingAttribute) {
					entry.element.setAttribute("loading", entry.loadingValue ?? "lazy");
				} else {
					entry.element.removeAttribute("loading");
				}
			});
			animationStyle.remove();
			if (scrollRoot.element?.isConnected) {
				scrollRoot.scrollTo(originalScroll.rootX, originalScroll.rootY);
			}
			window.scrollTo(originalScroll.x, originalScroll.y);
		} catch {}
	};
}

// ---- Smart height estimation ----

export async function estimateSmartHeight(
	scrollRoot: ScrollRootTarget,
	jobId: string,
	jobStartedAt: number,
	initialMetrics: PageMetrics,
	options: CaptureOptions,
): Promise<SmartHeightEstimate> {
	const maxAllowedByGrowth = Math.min(
		options.maxCaptureHeightPx,
		initialMetrics.totalHeight + options.maxExtraHeightPx,
	);
	let estimatedHeight = Math.min(
		initialMetrics.totalHeight,
		maxAllowedByGrowth,
	);
	let maxWidth = initialMetrics.totalWidth;
	let stablePasses = 0;
	let passCount = 0;
	let limitReason: PreflightLimitReason | undefined;
	const preflightStartedAt = Date.now();

	await reportPreflightProgress(jobId, {
		progress: 0,
		pass: 0,
		elapsedMs: 0,
	});

	while (stablePasses < PRE_FLIGHT_STABLE_PASSES) {
		ensureWithinTimeout(jobStartedAt, "smart-scroll preflight");

		const elapsedBeforePassMs = Date.now() - preflightStartedAt;
		if (passCount >= PRE_FLIGHT_MAX_PASSES) {
			limitReason = "pass";
			break;
		}
		if (elapsedBeforePassMs >= PRE_FLIGHT_MAX_DURATION_MS) {
			limitReason = "time";
			break;
		}

		const targetY = Math.max(
			0,
			estimatedHeight - initialMetrics.viewportHeight,
		);
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
			Math.max(
				passCount / PRE_FLIGHT_MAX_PASSES,
				elapsedMs / PRE_FLIGHT_MAX_DURATION_MS,
			),
		);
		await reportPreflightProgress(jobId, {
			progress,
			pass: passCount,
			elapsedMs,
		});
	}

	const finalElapsedMs = Date.now() - preflightStartedAt;
	const finalDetail =
		limitReason === "pass"
			? `Smart-scroll preflight capped at ${PRE_FLIGHT_MAX_PASSES} passes.`
			: limitReason === "time"
				? `Smart-scroll preflight capped at ${Math.round(PRE_FLIGHT_MAX_DURATION_MS / 1000)}s.`
				: undefined;
	await reportPreflightProgress(jobId, {
		progress: 1,
		pass: passCount,
		elapsedMs: finalElapsedMs,
		limitReason,
		detail: finalDetail,
	});

	return {
		finalHeight: estimatedHeight,
		maxWidth,
		limitReason,
	};
}

// ---- Tile capture (incremental scroll, no fixed plan) ----

const HORIZONTAL_OVERLAP_PX = 20;
const VERTICAL_OVERLAP_FIRST_PX = 150; // header buffer for first row
const VERTICAL_OVERLAP_REST_PX = 40;
const MAX_CAPTURE_TILES = 500;

interface ViewportDimensions {
	width: number;
	height: number;
	scrollbarWidth: number;
	scrollbarHeight: number;
}

export function measureViewport(): ViewportDimensions {
	const withScrollbarW = window.innerWidth;
	const withScrollbarH = window.innerHeight;
	// Remove scrollbars temporarily to measure true viewport
	const doc = document.documentElement;
	const originalOverflow = doc.style.overflow;
	doc.style.overflow = "hidden";
	const withoutScrollbarW = window.innerWidth;
	const withoutScrollbarH = window.innerHeight;
	doc.style.overflow = originalOverflow;
	return {
		width: withoutScrollbarW,
		height: withoutScrollbarH,
		scrollbarWidth: Math.max(0, withScrollbarW - withoutScrollbarW),
		scrollbarHeight: Math.max(0, withScrollbarH - withoutScrollbarH),
	};
}

export async function captureAllTiles(
	scrollRoot: ScrollRootTarget,
	jobId: string,
	jobStartedAt: number,
	metrics: PageMetrics,
	options: CaptureOptions,
): Promise<void> {
	const viewport = measureViewport();
	const xStep = Math.max(1, viewport.width - HORIZONTAL_OVERLAP_PX);
	const maxX = Math.max(0, metrics.totalWidth - viewport.width);
	const maxY = Math.max(0, metrics.totalHeight - viewport.height);

	let y = 0;
	let tileIndex = 0;
	let firstRow = true;
	let lastScrolledX = 0;
	let lastScrolledY = 0;

	while (y <= maxY && tileIndex < MAX_CAPTURE_TILES) {
		let x = 0;
		while (x <= maxX && tileIndex < MAX_CAPTURE_TILES) {
			ensureWithinTimeout(jobStartedAt, "tile capture");

			scrollRoot.scrollTo(x, y);
			await waitForSettledFrame(options);

			// Read actual scroll position (may differ from intended due to sticky headers, iframes, etc.)
			lastScrolledX = scrollRoot.getScrollLeft();
			lastScrolledY = scrollRoot.getScrollTop();

			// Stop horizontal pass if scroll did not advance (end of scrollable area)
			if (x > 0 && lastScrolledX <= x - xStep + 2) {
				break;
			}

			const currentMetrics = scrollRoot.readMetrics();

			const payload: CaptureTilePayload = {
				x: lastScrolledX,
				y: lastScrolledY,
				complete: tileIndex / MAX_CAPTURE_TILES, // rough progress, refined by caller
				viewportWidth: viewport.width,
				viewportHeight: viewport.height,
				screenshotWidth: viewport.width,
				screenshotHeight: viewport.height,
				cropX: 0,
				cropY: 0,
				cropWidth: viewport.width,
				cropHeight: viewport.height,
				totalWidth: metrics.totalWidth,
				totalHeight: metrics.totalHeight,
				devicePixelRatio: window.devicePixelRatio,
			};

			const tileResponse = await sendMessage({
				type: "capture-tile",
				jobId,
				tile: payload,
			});
			if (!tileResponse.ok) {
				throw new Error(tileResponse.error || "Tile capture failed.");
			}

			tileIndex++;

			// Advance X. If we are at the last column, break.
			if (lastScrolledX >= maxX) break;
			x = lastScrolledX + xStep;
		}

		// Stop vertical pass if scroll did not advance
		const yAdvance = Math.max(
			1,
			viewport.height -
				(firstRow ? VERTICAL_OVERLAP_FIRST_PX : VERTICAL_OVERLAP_REST_PX),
		);
		if (y > 0 && lastScrolledY <= y - yAdvance + 2) {
			break;
		}

		if (lastScrolledY >= maxY) break;

		// Use larger overlap for first row (header buffer), smaller for rest
		const yOverlap = firstRow
			? VERTICAL_OVERLAP_FIRST_PX
			: VERTICAL_OVERLAP_REST_PX;
		firstRow = false;
		y = lastScrolledY + Math.max(1, viewport.height - yOverlap);
	}

	if (tileIndex >= MAX_CAPTURE_TILES) {
		console.warn(
			`[ContentScript] Capture capped at ${MAX_CAPTURE_TILES} tiles. Page may be incomplete.`,
		);
	}
}

// ---- Orchestration ----

export async function runCapture(
	jobId: string,
	options: CaptureOptions,
): Promise<void> {
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
				options,
			);
			metrics = {
				...metrics,
				totalWidth: Math.max(metrics.totalWidth, estimated.maxWidth),
				totalHeight: estimated.finalHeight,
			};
		} else {
			metrics = {
				...metrics,
				totalHeight: Math.min(metrics.totalHeight, options.maxCaptureHeightPx),
			};
		}

		ensureWithinTimeout(jobStartedAt, "initialization");
		scrollRoot.scrollTo(0, 0);
		if (scrollRoot.kind === "element") {
			window.scrollTo(0, 0);
		}
		await waitForSettledFrame(options);
		await captureAllTiles(scrollRoot, jobId, jobStartedAt, metrics, options);

		ensureWithinTimeout(jobStartedAt, "export preparation");
		const finishResponse = await sendMessage({
			type: "capture-finished",
			jobId,
		});
		if (!finishResponse.ok) {
			throw new Error(finishResponse.error || "Failed to export capture.");
		}
	} catch (error) {
		await sendMessage({
			type: "capture-failed",
			jobId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		restore();
	}
}
