import type {
	CaptureTilePayload,
	ExportFile,
	ExportOptions,
	RuntimeResponse,
} from "../shared/messages";
import { DEFAULT_EXPORT_OPTIONS } from "../shared/constants";
import { isPositiveFiniteNumber } from "../shared/utils";
import { JobManager } from "./job-manager";
import { CanvasCompositor } from "./canvas-compositor";
import { ExportEngine } from "./export-engine";

interface AddTileMessage {
	type: "offscreen-add-tile";
	jobId: string;
	tile: CaptureTilePayload;
	dataUrl: string;
}

interface ExportMessage {
	type: "offscreen-export";
	jobId: string;
	options?: Partial<ExportOptions>;
	metadata?: {
		pageUrl?: string;
		capturedAtIso?: string;
	};
}

interface ClearMessage {
	type: "offscreen-clear";
	jobId: string;
}

interface ResetMessage {
	type: "offscreen-reset";
	jobId: string;
}

interface CropExportMessage {
	type: "offscreen-export-visible-area";
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

type OffscreenMessage =
	| AddTileMessage
	| ExportMessage
	| ClearMessage
	| ResetMessage
	| CropExportMessage;

const JOB_TTL_MS = 5 * 60 * 1000;
const STALE_PURGE_INTERVAL_MS = 60 * 1000;

// ---- Composition root ----

const jobManager = new JobManager(JOB_TTL_MS, STALE_PURGE_INTERVAL_MS);
const compositor = new CanvasCompositor((jobId) =>
	jobManager.getOrCreateJob(jobId),
);
const exportEngine = new ExportEngine(() => import("jspdf"));

jobManager.startStalePurgeInterval();

if (typeof self !== "undefined") {
	self.addEventListener("beforeunload", () => jobManager.dispose());
}

// ---- Helpers ----

function normalizeExportOptions(input?: Partial<ExportOptions>): ExportOptions {
	const q = Number(input?.jpgQuality);
	return {
		...DEFAULT_EXPORT_OPTIONS,
		...(input ?? {}),
		jpgQuality: isPositiveFiniteNumber(q)
			? Math.max(0.4, Math.min(1, q))
			: DEFAULT_EXPORT_OPTIONS.jpgQuality,
	};
}

// ---- Message handlers ----

async function addTile(
	message: AddTileMessage,
): Promise<RuntimeResponse<{ splitCount: number }>> {
	try {
		const result = await compositor.addTile(
			message.jobId,
			message.tile,
			message.dataUrl,
		);
		return { ok: true, data: result };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function exportJob(
	message: ExportMessage,
): Promise<RuntimeResponse<{ captures: ExportFile[] }>> {
	const job = jobManager.getOrCreateJob(message.jobId);

	const finalized = await compositor.finalize(message.jobId);
	if (!finalized.blobs.length) {
		return { ok: false, error: "No captured data for this job." };
	}

	const options = normalizeExportOptions(message.options);
	let captures: ExportFile[];
	if (options.format === "pdf") {
		captures = await exportEngine.exportAsPdfFromBlobs(
			finalized.blobs,
			finalized.width,
			finalized.height,
		);
	} else {
		captures = await exportEngine.exportAsRasterFromBlobs(
			finalized.blobs,
			options,
		);
	}

	jobManager.clearJob(message.jobId);
	return { ok: true, data: { captures } };
}

async function exportVisibleArea(
	message: CropExportMessage,
): Promise<RuntimeResponse<{ captures: ExportFile[] }>> {
	const options = normalizeExportOptions(message.options);
	const captures = await exportEngine.exportVisibleArea(
		message.dataUrl,
		message.area,
		options,
	);
	return { ok: true, data: { captures } };
}

function clearJob(message: ClearMessage): RuntimeResponse {
	jobManager.clearJob(message.jobId);
	return { ok: true };
}

function resetJob(message: ResetMessage): RuntimeResponse {
	jobManager.resetJob(message.jobId);
	return { ok: true };
}

// ---- Message validation ----

function isMessage(value: unknown): value is OffscreenMessage {
	if (!value || typeof value !== "object") return false;
	const msg = value as Record<string, unknown>;
	if (!("type" in msg)) return false;
	const type = msg.type;
	return (
		type === "offscreen-add-tile" ||
		type === "offscreen-export" ||
		type === "offscreen-clear" ||
		type === "offscreen-reset" ||
		type === "offscreen-export-visible-area"
	);
}

// ---- Runtime listener ----

chrome.runtime.onMessage.addListener(
	(message: OffscreenMessage, _sender, sendResponse) => {
		if (!isMessage(message)) {
			return false;
		}

		switch (message.type) {
			case "offscreen-add-tile":
				void addTile(message)
					.then((response) => sendResponse(response))
					.catch((error) =>
						sendResponse({
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				return true;

			case "offscreen-export":
				void exportJob(message)
					.then((response) => sendResponse(response))
					.catch((error) =>
						sendResponse({
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				return true;

			case "offscreen-export-visible-area":
				void exportVisibleArea(message)
					.then((response) => sendResponse(response))
					.catch((error) =>
						sendResponse({
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				return true;

			case "offscreen-clear":
				sendResponse(clearJob(message));
				return false;

			case "offscreen-reset":
				sendResponse(resetJob(message));
				return false;

			default:
				return false;
		}
	},
);
