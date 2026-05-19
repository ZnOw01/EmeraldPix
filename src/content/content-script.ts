import type { CaptureOptions, RuntimeResponse } from "../shared/messages";
import { runCapture, normalizeOptions } from "./page-scanner";
import { requestVisibleAreaSelection } from "./area-selector";

declare const __BUILD_ID__: string;

interface StartMessage {
	type: "start-capture";
	jobId: string;
	options?: Partial<CaptureOptions>;
}

interface SelectAreaMessage {
	type: "select-area";
}

interface PingMessage {
	type: "capture-ping";
}

type ContentMessage = StartMessage | PingMessage | SelectAreaMessage;

interface VisibleAreaSelection {
	x: number;
	y: number;
	width: number;
	height: number;
	devicePixelRatio: number;
}

const CONTENT_LISTENER_KEY = "__emeraldpixListenerInstalled__";
const RUNTIME_LISTENER_KEY = "__emeraldpixRuntimeListener__";
const LISTENER_BUILD_ID_KEY = "__emeraldpixListenerBuildId__";

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

function handleRuntimeMessage(
	message: ContentMessage,
	sender: chrome.runtime.MessageSender,
	sendResponse: (
		response: RuntimeResponse<
			| { ready?: true; capturing?: boolean; buildId?: string }
			| VisibleAreaSelection
		>,
	) => void,
): boolean {
	if (sender.id !== chrome.runtime.id) {
		return false;
	}
	if (!message || typeof message !== "object" || !("type" in message)) {
		return false;
	}

	if (message.type === "capture-ping") {
		sendResponse({
			ok: true,
			data: { ready: true, capturing: captureLock, buildId: __BUILD_ID__ },
		});
		return false;
	}

	if (message.type === "select-area") {
		void requestVisibleAreaSelection()
			.then((selection) => sendResponse({ ok: true, data: selection }))
			.catch((error) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				} satisfies RuntimeResponse),
			);
		return true;
	}

	if (message.type !== "start-capture" || !message.jobId) {
		return false;
	}

	if (!tryAcquireCaptureLock()) {
		sendResponse({
			ok: false,
			error: "Capture already in progress.",
		} satisfies RuntimeResponse);
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

if (
	!globalScope[CONTENT_LISTENER_KEY] ||
	globalScope[LISTENER_BUILD_ID_KEY] !== __BUILD_ID__
) {
	chrome.runtime.onMessage.addListener(handleRuntimeMessage);
	globalScope[RUNTIME_LISTENER_KEY] = handleRuntimeMessage;
	globalScope[LISTENER_BUILD_ID_KEY] = __BUILD_ID__;
	globalScope[CONTENT_LISTENER_KEY] = true;
}
