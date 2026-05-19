import type {
	CaptureOptions,
	CaptureStatus,
	CaptureTilePayload,
	DownloadOptions,
	ExportFile,
	ExportOptions,
	RuntimeResponse,
} from "../shared/messages";
import { getErrorMessage } from "../shared/utils";
import {
	validateCaptureTilePayload,
	validatePreflightProgress,
	validateCaptureFinished,
	validateCaptureFailed,
} from "../shared/message-schemas";
import {
	isCapturableUrl,
	OFFSCREEN_IDLE_CLOSE_MS,
	JOB_TIMEOUT_MS,
	EXPORT_TIMEOUT_MS,
	PREFLIGHT_PROGRESS_WEIGHT,
	BLANK_TILE_MAX_RETRIES,
	BLANK_TILE_RETRY_DELAY_MS,
} from "../shared/constants";
import { CaptureOrchestrator } from "../capture-orchestrator/orchestrator";
import type {
	JobDescriptor,
	ExportResult,
} from "../capture-orchestrator/types";
import {
	loadCaptureOptions,
	loadExportOptions,
	loadDownloadOptions,
	nextScreenshotFilename,
} from "./options-sanitizer";
import { createChromeTabCaptureAdapter } from "./adapters/chrome-tab-capture";
import { createChromeOffscreenAdapter } from "./adapters/chrome-offscreen";
import { createChromeDownloadAdapter } from "./adapters/chrome-downloads";
import { createChromeStatusBroadcaster } from "./adapters/chrome-status-broadcaster";

interface StartCaptureResponse {
	status: CaptureStatus;
	alreadyRunning: boolean;
}

interface VisibleAreaSelection {
	x: number;
	y: number;
	width: number;
	height: number;
	devicePixelRatio: number;
}

type RuntimeMessage =
	| { type: "start-capture" }
	| { type: "start-area-capture" }
	| { type: "start-capture-target"; tabId: number }
	| { type: "get-capture-status" }
	| {
			type: "capture-preflight-progress";
			jobId: string;
			progress: number;
			pass: number;
			maxPasses: number;
			elapsedMs: number;
			maxDurationMs: number;
			limitReason?: "pass" | "time";
			detail?: string;
	  }
	| { type: "capture-tile"; jobId: string; tile: CaptureTilePayload }
	| { type: "capture-finished"; jobId: string }
	| { type: "capture-failed"; jobId: string; error?: string };

// DEV_MODE flag injected by Vite - only true in development builds
declare const __DEV_MODE__: boolean;
declare const __BUILD_ID__: string;

const DEV_RELOAD_ALARM = "dev-reload-check";
const DEV_RELOAD_PERIOD_MINUTES = 0.05;

let offscreenCreationPromise: Promise<void> | null = null;
let offscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;

const orchestrator = new CaptureOrchestrator(
	createChromeTabCaptureAdapter(),
	createChromeOffscreenAdapter(),
	createChromeDownloadAdapter(),
	createChromeStatusBroadcaster(),
	{
		jobTimeoutMs: JOB_TIMEOUT_MS,
		exportTimeoutMs: EXPORT_TIMEOUT_MS,
		preflightProgressWeight: PREFLIGHT_PROGRESS_WEIGHT,
		statusUpdateIntervalMs: 100,
	},
);

// ---- Offscreen document lifecycle (separate concern from capture flow) ----

async function ensureOffscreenDocument(): Promise<void> {
	cancelScheduledOffscreenClose();

	if (typeof chrome.offscreen === "undefined") {
		throw new Error(
			"The offscreen document API is not available. This extension requires a compatible Chromium-based browser version 120 or later. " +
				"Please update your browser to use EmeraldPix.",
		);
	}

	if (offscreenCreationPromise) {
		await offscreenCreationPromise;
		return;
	}

	offscreenCreationPromise = (async () => {
		try {
			await chrome.offscreen.createDocument({
				url: "offscreen.html",
				reasons: ["BLOBS"],
				justification:
					"Compose full-page screenshots off the visible UI thread.",
			});
		} catch (error) {
			const message = getErrorMessage(error);
			if (!message.includes("Only a single offscreen document")) {
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
	// Only schedule close if there is no active job
	if (orchestrator.getStatus().state === "running") {
		return;
	}
	offscreenCloseTimer = setTimeout(() => {
		void closeOffscreenDocumentIfIdle();
	}, OFFSCREEN_IDLE_CLOSE_MS);
}

async function closeOffscreenDocumentIfIdle(): Promise<void> {
	if (
		orchestrator.getStatus().state === "running" ||
		typeof chrome.offscreen === "undefined"
	) {
		return;
	}
	try {
		await chrome.offscreen.closeDocument();
	} catch (error) {
		const message = getErrorMessage(error);
		if (!message.includes("No current offscreen document")) {
			console.warn(
				`[ServiceWorker] Failed to close offscreen document: ${message}`,
			);
		}
	}
}

// ---- Content script injection ----

async function pingContentScript(tabId: number): Promise<boolean> {
	try {
		const response = (await chrome.tabs.sendMessage(tabId, {
			type: "capture-ping",
		})) as RuntimeResponse<{ ready?: boolean; buildId?: string }>;
		return Boolean(
			response.ok &&
				response.data?.ready &&
				response.data?.buildId === __BUILD_ID__,
		);
	} catch {
		return false;
	}
}

async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
	if (await pingContentScript(tabId)) {
		return true;
	}

	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ["assets/content_script.js"],
		});
	} catch {
		// executeScript can fail on chrome://, file:// without access, etc.
		return false;
	}

	return await pingContentScript(tabId);
}

async function captureVisibleFallback(
	tab: chrome.tabs.Tab,
	job: JobDescriptor,
): Promise<RuntimeResponse<StartCaptureResponse>> {
	const exportOptions = await loadExportOptions();
	const downloadOptions = await loadDownloadOptions();

	try {
		const dataUrl = await createChromeTabCaptureAdapter().capture(tab.windowId);
		const offscreen = createChromeOffscreenAdapter();
		const captures = await offscreen.exportVisibleArea(
			dataUrl,
			{
				x: 0,
				y: 0,
				width: 0,
				height: 0,
				devicePixelRatio: 1,
			},
			exportOptions,
		);

		if (!captures.length) {
			throw new Error("No screenshots were generated.");
		}

		const downloads = createChromeDownloadAdapter();
		for (let i = 0; i < captures.length; i += 1) {
			const item = captures[i];
			const filename =
				captures.length <= 1 || i === 0
					? `${job.filename}.${item.extension}`
					: `${job.filename}-${i + 1}.${item.extension}`;
			await downloads.download(item, filename, downloadOptions.askWhereToSave);
		}

		await offscreen.clear(job.id);
		orchestrator.abort();
		scheduleOffscreenClose();

		return statusToResponse(orchestrator.getStatus());
	} catch (error) {
		orchestrator.abort();
		scheduleOffscreenClose();
		return { ok: false, error: getErrorMessage(error) };
	}
}

// ---- URL validation (shared/isCapturableUrl) ----

// ---- Dev reload ----

async function checkForDevBuildUpdate(): Promise<void> {
	if (!__DEV_MODE__) {
		return;
	}

	try {
		const response = await fetch(
			`${chrome.runtime.getURL("build-meta.json")}?t=${Date.now()}`,
			{
				cache: "no-store",
			},
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
			periodInMinutes: DEV_RELOAD_PERIOD_MINUTES,
		});
	}
}

// ---- Capture orchestration (delegated to CaptureOrchestrator) ----

function statusToResponse(
	status: CaptureStatus,
): RuntimeResponse<StartCaptureResponse> {
	return {
		ok: true,
		data: {
			status,
			alreadyRunning: status.state === "running",
		},
	};
}

async function startCaptureForTab(
	tabId?: number,
): Promise<RuntimeResponse<StartCaptureResponse>> {
	const existingStatus = orchestrator.getStatus();
	if (existingStatus.state === "running") {
		return statusToResponse(existingStatus);
	}

	let tab: chrome.tabs.Tab | undefined;
	if (tabId) {
		tab = await chrome.tabs.get(tabId).catch(() => undefined);
	} else {
		const tabs = await chrome.tabs.query({
			active: true,
			lastFocusedWindow: true,
		});
		tab = tabs[0];
	}

	if (!tab || !tab.id || !tab.windowId) {
		return { ok: false, error: "No active tab found." };
	}

	if (!isCapturableUrl(tab.url)) {
		return {
			ok: false,
			error: "This URL cannot be captured by browser extension policy.",
		};
	}

	const captureOptions = await loadCaptureOptions();
	const exportOptions = await loadExportOptions();
	const downloadOptions = await loadDownloadOptions();

	const job: JobDescriptor = {
		id: crypto.randomUUID(),
		tabId: tab.id,
		windowId: tab.windowId,
		filename: await nextScreenshotFilename(),
		options: captureOptions,
		exportOptions,
		downloadOptions,
		usesPreflight: captureOptions.enableSmartScroll,
	};

	await ensureOffscreenDocument();
	await createChromeOffscreenAdapter().reset(job.id);
	const contentScriptReady = await ensureContentScriptInjected(tab.id);

	const result = orchestrator.start(job);
	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	if (!contentScriptReady) {
		// Fallback: capture the visible area only when the content script
		// cannot be injected (e.g. chrome://, restricted pages, etc.)
		return captureVisibleFallback(tab, job);
	}

	const contentScriptStartResponse = (await chrome.tabs.sendMessage(tab.id, {
		type: "start-capture",
		jobId: job.id,
		options: captureOptions,
	})) as RuntimeResponse;

	if (!contentScriptStartResponse.ok) {
		await orchestrator.onFailed(
			job.id,
			contentScriptStartResponse.error ||
				"Content script rejected capture start.",
		);
		return { ok: false, error: "Unable to initialize capture pipeline." };
	}

	return statusToResponse(orchestrator.getStatus());
}

async function startAreaCapture(): Promise<
	RuntimeResponse<StartCaptureResponse>
> {
	const existingStatus = orchestrator.getStatus();
	if (existingStatus.state === "running") {
		return statusToResponse(existingStatus);
	}

	const tabs = await chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	});
	const tab = tabs[0];
	if (!tab || !tab.id || !tab.windowId) {
		return { ok: false, error: "No active tab found." };
	}
	if (!isCapturableUrl(tab.url)) {
		return {
			ok: false,
			error: "This URL cannot be captured by browser extension policy.",
		};
	}

	const exportOptions = await loadExportOptions();
	const downloadOptions = await loadDownloadOptions();

	const job: JobDescriptor = {
		id: crypto.randomUUID(),
		tabId: tab.id,
		windowId: tab.windowId,
		filename: await nextScreenshotFilename(),
		options: await loadCaptureOptions(),
		exportOptions,
		downloadOptions,
		usesPreflight: false,
	};

	await ensureOffscreenDocument();
	const contentScriptReady = await ensureContentScriptInjected(tab.id);

	const result = orchestrator.start(job);
	if (!result.ok) {
		return { ok: false, error: result.error };
	}

	if (!contentScriptReady) {
		return captureVisibleFallback(tab, job);
	}

	try {
		const selectionResponse = (await chrome.tabs.sendMessage(tab.id, {
			type: "select-area",
		})) as RuntimeResponse<VisibleAreaSelection>;

		if (!selectionResponse.ok || !selectionResponse.data) {
			const error = selectionResponse.ok
				? "Area selection cancelled."
				: selectionResponse.error;
			orchestrator.abort();
			scheduleOffscreenClose();
			return { ok: false, error };
		}

		const dataUrl = await createChromeTabCaptureAdapter().capture(tab.windowId);
		const offscreen = createChromeOffscreenAdapter();
		const captures = await offscreen.exportVisibleArea(
			dataUrl,
			selectionResponse.data,
			exportOptions,
		);

		if (!captures.length) {
			throw new Error("No screenshots were generated.");
		}

		const downloads = createChromeDownloadAdapter();
		for (let i = 0; i < captures.length; i += 1) {
			const item = captures[i];
			const filename =
				captures.length <= 1 || i === 0
					? `${job.filename}.${item.extension}`
					: `${job.filename}-${i + 1}.${item.extension}`;
			await downloads.download(item, filename, downloadOptions.askWhereToSave);
		}

		await offscreen.clear(job.id);
		orchestrator.abort();
		scheduleOffscreenClose();

		return statusToResponse(orchestrator.getStatus());
	} catch (error) {
		const message = getErrorMessage(error);
		if (message === "Area selection cancelled.") {
			orchestrator.abort();
			scheduleOffscreenClose();
			return { ok: false, error: message };
		}
		// For area capture we use abort to clean up since there's no tile-based failure path
		orchestrator.abort();
		scheduleOffscreenClose();
		return { ok: false, error: message };
	}
}

// ---- Message handlers ----

type CaptureJobMessage = Extract<
	RuntimeMessage,
	{
		type:
			| "capture-preflight-progress"
			| "capture-tile"
			| "capture-finished"
			| "capture-failed";
	}
>;

function isCaptureJobMessage(
	message: RuntimeMessage,
): message is CaptureJobMessage {
	return (
		message.type === "capture-preflight-progress" ||
		message.type === "capture-tile" ||
		message.type === "capture-finished" ||
		message.type === "capture-failed"
	);
}

function isTrustedSender(
	message: RuntimeMessage,
	sender: chrome.runtime.MessageSender,
): boolean {
	if (sender.id && sender.id !== chrome.runtime.id) {
		return false;
	}

	const status = orchestrator.getStatus();

	if (isCaptureJobMessage(message)) {
		// For preflight progress, tile, finish, fail: must come from the active content-script tab.
		// We verify the job exists and sender matches the active tab.
		// The orchestrator internally validates jobId.
		if (status.state !== "running") {
			return false;
		}
		if (!sender.tab?.id) {
			return false;
		}
		// Note: we don't strictly check tabId here because the orchestrator will reject
		// stale jobIds anyway. We just ensure it's a tab context.
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

chrome.runtime.onMessage.addListener(
	(message: RuntimeMessage, sender, sendResponse) => {
		if (!message || typeof message !== "object" || !("type" in message)) {
			return false;
		}
		if (!isTrustedSender(message, sender)) {
			sendResponse({
				ok: false,
				error: "Rejected message from untrusted sender.",
			});
			return false;
		}

		switch (message.type) {
			case "start-capture":
				void startCaptureForTab()
					.then((response) => sendResponse(response))
					.catch((error) =>
						sendResponse({ ok: false, error: getErrorMessage(error) }),
					);
				return true;

			case "start-area-capture":
				void startAreaCapture()
					.then((response) => sendResponse(response))
					.catch((error) =>
						sendResponse({ ok: false, error: getErrorMessage(error) }),
					);
				return true;

			case "start-capture-target":
				void startCaptureForTab(message.tabId)
					.then((response) => sendResponse(response))
					.catch((error) =>
						sendResponse({ ok: false, error: getErrorMessage(error) }),
					);
				return true;

			case "get-capture-status":
				sendResponse({
					ok: true,
					data: { status: orchestrator.getStatus() },
				} satisfies RuntimeResponse<{ status: CaptureStatus }>);
				return false;

			case "capture-preflight-progress": {
				const preflightResult = validatePreflightProgress(message);
				if (!preflightResult.ok) {
					sendResponse({ ok: false, error: preflightResult.error });
					return false;
				}
				orchestrator.onPreflightProgress(preflightResult.value);
				sendResponse({ ok: true });
				return false;
			}

			case "capture-tile": {
				const tileResult = validateCaptureTilePayload(message.tile);
				if (!tileResult.ok) {
					sendResponse({ ok: false, error: tileResult.error });
					return false;
				}
				const jobId = message.jobId;
				
				void (async () => {
					let blankRetries = 0;

					while (blankRetries <= BLANK_TILE_MAX_RETRIES) {
						try {
							const dataUrl = await createChromeTabCaptureAdapter().capture(
								sender.tab?.windowId ?? 0,
							);
							const result = await orchestrator.onTile(
								jobId,
								tileResult.value,
								dataUrl,
							);

							if (result.ok) {
								if (result.value.isBlank && blankRetries < BLANK_TILE_MAX_RETRIES) {
									blankRetries += 1;
									await new Promise((resolve) =>
										setTimeout(resolve, BLANK_TILE_RETRY_DELAY_MS),
									);
									continue;
								}
								sendResponse({ ok: true });
							} else {
								sendResponse({ ok: false, error: result.error });
							}
							return;
						} catch (error) {
							sendResponse({ ok: false, error: getErrorMessage(error) });
							return;
						}
					}
				})();
				return true;
			}

			case "capture-finished": {
				const finishedResult = validateCaptureFinished(message);
				if (!finishedResult.ok) {
					sendResponse({ ok: false, error: finishedResult.error });
					return false;
				}
				void orchestrator
					.onFinished(finishedResult.value.jobId)
					.then((result) => {
						if (result.ok) {
							sendResponse({ ok: true });
							scheduleOffscreenClose();
						} else {
							sendResponse({ ok: false, error: result.error });
							scheduleOffscreenClose();
						}
					})
					.catch((error) => {
						sendResponse({ ok: false, error: getErrorMessage(error) });
						scheduleOffscreenClose();
					});
				return true;
			}

			case "capture-failed": {
				const failedResult = validateCaptureFailed(message);
				if (!failedResult.ok) {
					sendResponse({ ok: false, error: failedResult.error });
					return false;
				}
				void orchestrator
					.onFailed(
						failedResult.value.jobId,
						failedResult.value.error || "Capture stopped unexpectedly.",
					)
					.then(() => {
						sendResponse({ ok: true });
						scheduleOffscreenClose();
					})
					.catch((error) => {
						sendResponse({ ok: false, error: getErrorMessage(error) });
						scheduleOffscreenClose();
					});
				return true;
			}

			default:
				return false;
		}
	},
);
