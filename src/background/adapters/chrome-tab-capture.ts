import { getErrorMessage } from "../../shared/utils";
import {
	CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS,
	CAPTURE_VISIBLE_TAB_MAX_RETRIES,
	CAPTURE_VISIBLE_TAB_BACKOFF_BASE_MS,
	CAPTURE_VISIBLE_TAB_BACKOFF_MAX_MS,
} from "../../shared/constants";
import type { TabCaptureAdapter } from "../../capture-orchestrator/types";

const CAPTURE_VISIBLE_TAB_QUOTA_PATTERNS = [
	/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i,
	/captureVisibleTab.*quota/i,
	/Too many captureVisibleTab calls/i,
];

const CAPTURE_VISIBLE_TAB_NON_RETRYABLE_PATTERNS = [
	/tab.*hidden/i,
	/tab.*minimized/i,
	/tab.*not visible/i,
	/window.*minimized/i,
	/window.*hidden/i,
	/not visible/i,
	/cannot capture/i,
];

function isCaptureVisibleTabQuotaError(error: unknown): boolean {
	const message = getErrorMessage(error);
	return CAPTURE_VISIBLE_TAB_QUOTA_PATTERNS.some((pattern) =>
		pattern.test(message),
	);
}

function isNonRetryableCaptureError(error: unknown): boolean {
	const message = getErrorMessage(error);
	return CAPTURE_VISIBLE_TAB_NON_RETRYABLE_PATTERNS.some((pattern) =>
		pattern.test(message),
	);
}

function getCaptureVisibleTabRetryDelayMs(attempt: number): number {
	const exponentialMs = Math.min(
		CAPTURE_VISIBLE_TAB_BACKOFF_MAX_MS,
		CAPTURE_VISIBLE_TAB_BACKOFF_BASE_MS * 2 ** attempt,
	);
	return Math.max(CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS, exponentialMs);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChromeTabCaptureAdapter(): TabCaptureAdapter {
	let captureVisibleTabNextAllowedAt = 0;
	let captureVisibleTabRateLock: Promise<void> | null = null;

	async function waitForCaptureVisibleTabRateLimitSlot(): Promise<void> {
		const previousLock = captureVisibleTabRateLock ?? Promise.resolve();
		let releaseLock: () => void = () => undefined;
		captureVisibleTabRateLock = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});

		await previousLock;
		try {
			const waitMs = Math.max(0, captureVisibleTabNextAllowedAt - Date.now());
			if (waitMs > 0) {
				await sleep(waitMs);
			}
			captureVisibleTabNextAllowedAt =
				Date.now() + CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS;
		} finally {
			releaseLock();
		}
	}

	return {
		async capture(windowId: number): Promise<string> {
			let lastError: unknown = new Error("Unknown capture error.");
			for (
				let attempt = 0;
				attempt <= CAPTURE_VISIBLE_TAB_MAX_RETRIES;
				attempt += 1
			) {
				await waitForCaptureVisibleTabRateLimitSlot();
				try {
					const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
						format: "png",
					});
					if (!dataUrl) {
						throw new Error("Empty screenshot data.");
					}
					return dataUrl;
				} catch (error) {
					lastError = error;
					if (isNonRetryableCaptureError(error)) {
						throw error;
					}
					if (
						!isCaptureVisibleTabQuotaError(error) ||
						attempt >= CAPTURE_VISIBLE_TAB_MAX_RETRIES
					) {
						throw error;
					}
					await sleep(getCaptureVisibleTabRetryDelayMs(attempt));
				}
			}
			throw new Error(getErrorMessage(lastError));
		},
	};
}
