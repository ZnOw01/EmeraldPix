import type {
	CaptureOptions,
	DownloadOptions,
	ExportOptions,
} from "../shared/messages";
import {
	DEFAULT_CAPTURE_OPTIONS,
	DEFAULT_DOWNLOAD_OPTIONS,
	DEFAULT_EXPORT_OPTIONS,
} from "../shared/constants";
import { isPositiveFiniteNumber } from "../shared/utils";
import { readPersistedValue } from "../shared/persisted-store";

export async function loadCaptureOptions(): Promise<CaptureOptions> {
	const value = await readPersistedValue("captureOptions");
	if (!value || typeof value !== "object") {
		return DEFAULT_CAPTURE_OPTIONS;
	}
	return sanitizeCaptureOptions(value as Partial<CaptureOptions>);
}

export async function loadExportOptions(): Promise<ExportOptions> {
	const value = await readPersistedValue("exportOptions");
	if (!value || typeof value !== "object") {
		return DEFAULT_EXPORT_OPTIONS;
	}
	return sanitizeExportOptions(value as Partial<ExportOptions>);
}

export async function loadDownloadOptions(): Promise<DownloadOptions> {
	const value = await readPersistedValue("downloadOptions");
	if (!value || typeof value !== "object") {
		return DEFAULT_DOWNLOAD_OPTIONS;
	}
	return sanitizeDownloadOptions(value as Partial<DownloadOptions>);
}

export function sanitizeCaptureOptions(
	input: Partial<CaptureOptions>,
): CaptureOptions {
	const lazyLoadWaitMs = isPositiveFiniteNumber(input.lazyLoadWaitMs)
		? Math.round(input.lazyLoadWaitMs)
		: DEFAULT_CAPTURE_OPTIONS.lazyLoadWaitMs;
	const settleFrames = isPositiveFiniteNumber(input.settleFrames)
		? Math.round(input.settleFrames)
		: DEFAULT_CAPTURE_OPTIONS.settleFrames;
	const heightGrowthThresholdPx = isPositiveFiniteNumber(
		input.heightGrowthThresholdPx,
	)
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
		maxCaptureHeightPx,
	};
}

export function sanitizeExportOptions(
	input: Partial<ExportOptions>,
): ExportOptions {
	const format =
		input.format === "jpg" || input.format === "pdf" ? input.format : "png";
	const jpgQuality = isPositiveFiniteNumber(input.jpgQuality)
		? Math.max(0.4, Math.min(1, input.jpgQuality))
		: DEFAULT_EXPORT_OPTIONS.jpgQuality;
	return {
		...DEFAULT_EXPORT_OPTIONS,
		...input,
		format,
		jpgQuality,
	};
}

export function sanitizeDownloadOptions(
	input: Partial<DownloadOptions>,
): DownloadOptions {
	return {
		...DEFAULT_DOWNLOAD_OPTIONS,
		...input,
		askWhereToSave: Boolean(input.askWhereToSave),
	};
}

// Counter for screenshot numbering - persisted in storage to survive SW restarts
let screenshotCounter = 0;
let screenshotCounterInitialized = false;

async function initScreenshotCounter(): Promise<void> {
	if (screenshotCounterInitialized) return;
	try {
		const result = await chrome.storage.local.get("screenshotCounter");
		screenshotCounter = result.screenshotCounter || 0;
		screenshotCounterInitialized = true;
	} catch {
		screenshotCounter = 0;
		screenshotCounterInitialized = true;
	}
}

async function persistScreenshotCounter(): Promise<void> {
	try {
		await chrome.storage.local.set({ screenshotCounter });
	} catch {
		// Best effort - counter will reset on next SW restart if storage fails
	}
}

export async function nextScreenshotFilename(): Promise<string> {
	await initScreenshotCounter();
	screenshotCounter++;
	await persistScreenshotCounter();
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const time = now.toTimeString().slice(0, 8).replace(/:/g, "-");
	return `Screenshot_${date}_${time}_${screenshotCounter}`;
}
