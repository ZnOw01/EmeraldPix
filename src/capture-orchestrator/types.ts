import type {
	CaptureOptions,
	CaptureStatus,
	CaptureTilePayload,
	DownloadOptions,
	ExportFile,
	ExportOptions,
	RuntimeResponse,
} from "../shared/messages";

/** Descripción de un job de captura para el orquestador. */
export interface JobDescriptor {
	id: string;
	tabId: number;
	windowId: number;
	filename: string;
	options: CaptureOptions;
	exportOptions: ExportOptions;
	downloadOptions: DownloadOptions;
	usesPreflight: boolean;
}

/** Progreso del preflight enviado por el content script. */
export interface PreflightProgress {
	jobId: string;
	progress: number;
	pass: number;
	maxPasses: number;
	elapsedMs: number;
	maxDurationMs: number;
	limitReason?: "pass" | "time";
	detail?: string;
}

/** Resultado de un tile procesado (usado internamente). */
export interface TilePayload extends CaptureTilePayload {}

/** Resultado de la exportación final. */
export interface ExportResult {
	dataUrl: string;
	extension: ExportOptions["format"];
}

/** Opciones de configuración del orquestador. */
export interface OrchestratorOptions {
	jobTimeoutMs: number;
	exportTimeoutMs: number;
	preflightProgressWeight: number;
	statusUpdateIntervalMs: number;
}

// ---- Adapters (seams) ----

/** Adaptador para capturar pestañas visibles. Oculta rate-limiting y retry. */
export interface TabCaptureAdapter {
	capture(windowId: number): Promise<string>;
}

/** Adaptador para comunicarse con el offscreen document. */
export interface OffscreenAdapter {
	reset(jobId: string): Promise<void>;
	addTile(
		jobId: string,
		tile: CaptureTilePayload,
		dataUrl: string,
	): Promise<{ splitCount: number; isBlank?: boolean }>;
	export(
		jobId: string,
		options: ExportOptions,
		metadata: ExportMetadata,
	): Promise<ExportResult[]>;
	clear(jobId: string): Promise<void>;
	exportVisibleArea(
		dataUrl: string,
		area: VisibleAreaSelection,
		options: ExportOptions,
	): Promise<ExportResult[]>;
}

export interface ExportMetadata {
	pageUrl: string;
	capturedAtIso: string;
}

export interface VisibleAreaSelection {
	x: number;
	y: number;
	width: number;
	height: number;
	devicePixelRatio: number;
}

/** Adaptador para descargar archivos. */
export interface DownloadAdapter {
	download(
		file: ExportFile,
		filename: string,
		askWhereToSave: boolean,
	): Promise<void>;
}

/** Adaptador para difundir cambios de estado al popup. */
export interface StatusBroadcaster {
	broadcast(status: CaptureStatus): void;
}

// ---- Errores ----

export type StartError = string;
export type TileError = string;
export type FinishedError = string;

export type Result<T, E = string> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E = string>(error: E): Result<never, E> {
	return { ok: false, error };
}
