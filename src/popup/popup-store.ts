import { writable } from "svelte/store";
import type {
	CaptureStatus,
	ExportFormat,
	RuntimeResponse,
} from "../shared/messages";
import type { Theme, ThemePreference } from "../shared/theme";
import {
	readPersistedValue,
	removePersistedValues,
	writePersistedValues,
} from "../shared/persisted-store";
import { formatMessage } from "../shared/format-message";
import { AREA_SELECTION_CANCELLED } from "../shared/utils";
import { isCapturableUrl } from "../shared/constants";
import {
	applyTheme,
	getThemePreference,
	initTheme,
	resetThemePreference,
	setThemePreference,
} from "../shared/theme";
import {
	composePersistedPopupSettings,
	createDefaultPopupSettingsState,
	createPopupSettingsState,
	type PopupSettingsState,
} from "./settings-model";
import { POPUP_COPY } from "./copy";

interface StartCaptureData {
	status: CaptureStatus;
	alreadyRunning: boolean;
}

const IDLE_STATUS: CaptureStatus = {
	state: "idle",
	progress: 0,
	splitCount: 1,
	downloadedCount: 0,
	totalCount: 0,
};

const COPY = POPUP_COPY as Record<string, string>;

function t(
	id: string,
	values: Record<
		string,
		string | number | boolean | Date | null | undefined
	> = {},
	fallback = id,
): string {
	return formatMessage(COPY[id] ?? fallback, values);
}

function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return count === 1 ? singular : plural;
}

function formatSavedFiles(count: number): string {
	return formatMessage("{count} {noun} saved", {
		count,
		noun: pluralize(count, "file"),
	});
}

function formatLargePageNotice(count: number): string {
	return t("popup.alerts.largePage", {
		count,
		fileWord: pluralize(count, "file"),
	});
}

export interface PopupStoreState {
	captureStatus: CaptureStatus;
	lastCaptureType: "full" | "area";
	settingsOpen: boolean;
	effectiveTheme: Theme;
	themePreference: ThemePreference;
	smartScroll: boolean;
	exportFormat: ExportFormat;
	jpgQuality: number;
	askWhereToSave: boolean;
	statusText: string;
	statusDetail: string;
	splitAlertVisible: boolean;
	splitAlertMessage: string;
	noticeAlertVisible: boolean;
	noticeAlertMessage: string;
	errorAlertVisible: boolean;
	errorAlertMessage: string;
	isIdle: boolean;
	isRunning: boolean;
	isDone: boolean;
	isError: boolean;
	captureRunning: boolean;
	showProgress: boolean;
	showCaptureButton: boolean;
	showRetryButton: boolean;
	progressPercent: number;
	captureButtonLabel: string;
	themeToggleLabel: string;
	jpgQualityPercent: number;
	screenReaderStatus: string;
	canCapture: boolean;
	uncapturableReason: string;
}

function deriveUI(
	status: CaptureStatus,
): Pick<
	PopupStoreState,
	| "statusText"
	| "statusDetail"
	| "splitAlertVisible"
	| "splitAlertMessage"
	| "noticeAlertVisible"
	| "noticeAlertMessage"
	| "errorAlertVisible"
	| "errorAlertMessage"
	| "isIdle"
	| "isRunning"
	| "isDone"
	| "isError"
	| "captureRunning"
	| "showProgress"
	| "showCaptureButton"
	| "showRetryButton"
	| "progressPercent"
	| "screenReaderStatus"
> {
	const isIdle = status.state === "idle";
	const isRunning = status.state === "running";
	const isDone = status.state === "done";
	const isError = status.state === "error";
	const captureRunning = isRunning;
	const showProgress = isRunning || isDone;
	const showCaptureButton = !isError;
	const showRetryButton = isError;
	const progressPercent = Math.round(
		Math.max(0, Math.min(1, status.progress)) * 100,
	);

	let statusText: string;
	let statusDetail = "";
	let splitAlertMessage = "";
	let splitAlertVisible = false;
	let noticeAlertMessage = "";
	let noticeAlertVisible = false;
	let errorAlertMessage = "";
	let errorAlertVisible = false;

	if (isIdle) {
		statusText = t("popup.status.readyToCapture");
	} else if (isRunning) {
		noticeAlertMessage = status.notice ?? "";
		noticeAlertVisible = Boolean(noticeAlertMessage);

		if (status.phase === "preflight") {
			statusText = t("popup.status.analyzingPage");
			statusDetail =
				status.phaseDetail ||
				t("popup.status.progressComplete", {
					progress: Math.round((status.phaseProgress ?? 0) * 100),
				});
		} else if (status.phase === "export") {
			statusText = t("popup.status.savingCapture");
			statusDetail = t("popup.status.downloadProgress", {
				downloaded: status.downloadedCount,
				total: status.totalCount || 1,
			});
		} else {
			statusText = t("popup.status.capturingPage");
			statusDetail = t("popup.status.progressComplete", {
				progress: Math.round((status.phaseProgress ?? status.progress) * 100),
			});
		}

		splitAlertMessage =
			status.phase === "capture" && status.splitCount > 1
				? formatLargePageNotice(status.splitCount)
				: "";
		splitAlertVisible = Boolean(splitAlertMessage);
	} else if (isDone) {
		statusText = t("popup.status.captureComplete");
		statusDetail = formatSavedFiles(status.downloadedCount);
		noticeAlertMessage = status.notice ?? "";
		noticeAlertVisible = Boolean(noticeAlertMessage);
	} else {
		statusText = t("popup.status.captureFailed");
		errorAlertMessage = status.error || t("errors.unknownError");
		errorAlertVisible = true;
	}

	const screenReaderStatus = statusDetail
		? `${statusText}. ${statusDetail}`
		: statusText;

	return {
		statusText,
		statusDetail,
		splitAlertVisible,
		splitAlertMessage,
		noticeAlertVisible,
		noticeAlertMessage,
		errorAlertVisible,
		errorAlertMessage,
		isIdle,
		isRunning,
		isDone,
		isError,
		captureRunning,
		showProgress,
		showCaptureButton,
		showRetryButton,
		progressPercent,
		screenReaderStatus,
	};
}

function computeDerivedLabels(
	state: PopupStoreState,
): Pick<
	PopupStoreState,
	"captureButtonLabel" | "themeToggleLabel" | "jpgQualityPercent"
> {
	return {
		captureButtonLabel: state.captureRunning
			? t("popup.actions.capturing")
			: t("popup.actions.capture"),
		themeToggleLabel:
			state.effectiveTheme === "light"
				? t("popup.actions.toggleThemeDark")
				: t("popup.actions.toggleThemeLight"),
		jpgQualityPercent: Math.round(state.jpgQuality * 100),
	};
}

function createState(settings: PopupSettingsState): PopupStoreState {
	const ui = deriveUI(IDLE_STATUS);
	const labels = computeDerivedLabels({
		captureRunning: ui.captureRunning,
		effectiveTheme: "light",
		jpgQuality: settings.jpgQuality,
	} as PopupStoreState);
	return {
		captureStatus: { ...IDLE_STATUS },
		lastCaptureType: "full",
		settingsOpen: false,
		effectiveTheme: "light",
		themePreference: "system",
		smartScroll: settings.smoothStitching,
		exportFormat: settings.exportFormat,
		jpgQuality: settings.jpgQuality,
		askWhereToSave: settings.askWhereToSave,
		...ui,
		...labels,
		canCapture: true,
		uncapturableReason: "",
	};
}

export interface PopupStoreDependencies {
	sendMessage<T>(message: unknown): Promise<RuntimeResponse<T>>;
	readPersistedValue: typeof readPersistedValue;
	writePersistedValues: typeof writePersistedValues;
	removePersistedValues: typeof removePersistedValues;
	initTheme: typeof initTheme;
	getThemePreference: typeof getThemePreference;
	setThemePreference: typeof setThemePreference;
	resetThemePreference: typeof resetThemePreference;
	applyTheme: typeof applyTheme;
	attachRuntimeListener?(
		callback: (message: { type?: string; status?: CaptureStatus }) => false,
	): () => void;
	getMediaQuery?(): MediaQueryList;
}

const defaultDependencies: PopupStoreDependencies = {
	sendMessage: async <T>(message: unknown) =>
		chrome.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>,
	readPersistedValue,
	writePersistedValues,
	removePersistedValues,
	initTheme,
	getThemePreference,
	setThemePreference,
	resetThemePreference,
	applyTheme,
	attachRuntimeListener: (callback) => {
		const listener = callback;
		chrome.runtime.onMessage.addListener(listener);
		return () => {
			chrome.runtime.onMessage.removeListener(listener);
		};
	},
	getMediaQuery: () => window.matchMedia("(prefers-color-scheme: dark)"),
};

export function createPopupStore(deps: Partial<PopupStoreDependencies> = {}) {
	const d = { ...defaultDependencies, ...deps };

	const defaults = createDefaultPopupSettingsState();
	const { subscribe, set, update } = writable<PopupStoreState>(
		createState(defaults),
	);

	// ---- Polling internals ----

	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let pollInFlight = false;
	let pollingDisposed = false;

	function recompute(state: PopupStoreState): PopupStoreState {
		const ui = deriveUI(state.captureStatus);
		const labels = computeDerivedLabels({
			captureRunning: ui.captureRunning,
			effectiveTheme: state.effectiveTheme,
			jpgQuality: state.jpgQuality,
		} as PopupStoreState);
		return { ...state, ...ui, ...labels };
	}

	function patch(partial: Partial<PopupStoreState>): void {
		update((s) => recompute({ ...s, ...partial }));
	}

	// ---- Settings ----

	function currentPopupSettingsState(): PopupSettingsState {
		let state: PopupSettingsState;
		update((s) => {
			state = {
				askWhereToSave: s.askWhereToSave,
				exportFormat: s.exportFormat,
				jpgQuality: s.jpgQuality,
				smoothStitching: s.smartScroll,
			};
			return s;
		});
		return state!;
	}

	async function saveOptionsFromUI(): Promise<void> {
		const persisted = composePersistedPopupSettings(
			currentPopupSettingsState(),
		);
		await d.writePersistedValues(persisted);
	}

	async function loadStoredPopupSettings(): Promise<PopupSettingsState> {
		const [captureOptions, exportOptions, downloadOptions] = await Promise.all([
			d.readPersistedValue("captureOptions"),
			d.readPersistedValue("exportOptions"),
			d.readPersistedValue("downloadOptions"),
		]);

		return createPopupSettingsState({
			captureOptions:
				captureOptions as Partial<PopupSettingsState>["exportFormat"] extends string
					? any
					: any,
			exportOptions: exportOptions as any,
			downloadOptions: downloadOptions as any,
		});
	}

	// ---- Capture ----

	async function executeCapture(
		captureType: "full" | "area",
		messageType: "start-capture" | "start-area-capture",
	): Promise<void> {
		patch({
			lastCaptureType: captureType,
			captureStatus: {
				...IDLE_STATUS,
				state: "running",
				phase: "preflight",
				phaseProgress: 0,
			},
		});
		await saveOptionsFromUI();

		try {
			const response = await d.sendMessage<StartCaptureData>({
				type: messageType,
			});
			if (!response.ok || !response.data) {
				if (!response.ok && response.error === AREA_SELECTION_CANCELLED) {
					patch({ captureStatus: { ...IDLE_STATUS } });
					return;
				}

				patch({
					captureStatus: {
						state: "error",
						progress: 0,
						splitCount: 1,
						downloadedCount: 0,
						totalCount: 0,
						error: response.ok
							? t("popup.errors.invalidStartStatus")
							: response.error,
					},
				});
				return;
			}

			patch({ captureStatus: response.data.status });
		} catch {
			patch({
				captureStatus: {
					state: "error",
					progress: 0,
					splitCount: 1,
					downloadedCount: 0,
					totalCount: 0,
					error: t("popup.errors.couldNotStart"),
				},
			});
		}
	}

	async function startCapture(): Promise<void> {
		return executeCapture("full", "start-capture");
	}

	async function startAreaCapture(): Promise<void> {
		return executeCapture("area", "start-area-capture");
	}

	function retryCapture(): void {
		let lastType: "full" | "area";
		update((s) => {
			lastType = s.lastCaptureType;
			return s;
		});
		if (lastType! === "area") {
			void startAreaCapture();
		} else {
			void startCapture();
		}
	}

	// ---- Polling ----

	async function pollStatus(): Promise<void> {
		if (pollInFlight) return;
		pollInFlight = true;

		try {
			const response = await d.sendMessage<{ status: CaptureStatus }>({
				type: "get-capture-status",
			});
			if (response.ok && response.data?.status) {
				patch({ captureStatus: response.data.status });
				pollInFlight = false;
				return;
			}
		} catch {
			// Treat runtime errors like status failures so polling is fully stopped.
		} finally {
			pollInFlight = false;
		}

		stopPolling();
		patch({
			captureStatus: {
				state: "error",
				progress: 0,
				splitCount: 1,
				downloadedCount: 0,
				totalCount: 0,
				error: t("popup.alerts.statusUnavailable"),
			},
		});
	}

	function startPolling(): void {
		if (pollingDisposed) return;
		stopPolling();
		pollTimer = setInterval(() => {
			if (!pollingDisposed && !pollInFlight) {
				void pollStatus();
			}
		}, 500);
	}

	function stopPolling(): void {
		if (pollTimer !== undefined) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	function disposePolling(): void {
		pollingDisposed = true;
		stopPolling();
	}

	// ---- Status rendering ----

	function renderStatus(status: CaptureStatus): void {
		patch({ captureStatus: status });
	}

	// ---- Theme ----

	async function toggleTheme(): Promise<void> {
		let current: Theme;
		update((s) => {
			current = s.effectiveTheme;
			return s;
		});
		const nextTheme: Theme = current! === "dark" ? "light" : "dark";
		await d.setThemePreference(nextTheme);
		patch({ themePreference: nextTheme, effectiveTheme: nextTheme });
	}

	async function applyThemeSelection(
		nextPreference: ThemePreference,
	): Promise<void> {
		patch({ themePreference: nextPreference });

		if (nextPreference === "system") {
			const resolved = await d.resetThemePreference();
			patch({ effectiveTheme: resolved });
		} else {
			await d.setThemePreference(nextPreference);
			patch({ effectiveTheme: nextPreference });
		}
	}

	// ---- Settings UI ----

	function openSettings(): void {
		patch({ settingsOpen: true });
	}

	function closeSettings(): void {
		patch({ settingsOpen: false });
	}

	async function handleFormatSelect(format: ExportFormat): Promise<void> {
		patch({ exportFormat: format });
		await saveOptionsFromUI();
	}

	async function toggleAskWhereToSave(): Promise<void> {
		update((s) => {
			const next = !s.askWhereToSave;
			void saveOptionsFromUI().then(() => {});
			return recompute({ ...s, askWhereToSave: next });
		});
	}

	async function toggleSmoothStitching(): Promise<void> {
		update((s) => {
			const next = !s.smartScroll;
			void saveOptionsFromUI().then(() => {});
			return recompute({ ...s, smartScroll: next });
		});
	}

	function setJpgQuality(value: number): void {
		patch({ jpgQuality: value });
		void saveOptionsFromUI();
	}

	async function handleResetSettings(): Promise<void> {
		if (!confirm(t("popup.modal.confirmReset"))) {
			return;
		}

		await d.removePersistedValues([
			"captureOptions",
			"exportOptions",
			"downloadOptions",
		]);
		const defaults = createDefaultPopupSettingsState();
		patch({
			smartScroll: defaults.smoothStitching,
			exportFormat: defaults.exportFormat,
			jpgQuality: defaults.jpgQuality,
			askWhereToSave: defaults.askWhereToSave,
		});
		await saveOptionsFromUI();

		patch({ themePreference: "system" });
		const resolved = await d.resetThemePreference();
		patch({ effectiveTheme: resolved });
		closeSettings();
	}

	function handleOpenDownloads(): void {
		const userAgent = navigator.userAgent;
		const url = userAgent.includes("Edg/")
			? "edge://downloads/"
			: "chrome://downloads/";
		chrome.tabs.create({ url });
	}

	function getRadioSelection<T extends string>(
		options: readonly T[],
		current: T,
		key: string,
	): T | null {
		const index = options.indexOf(current);
		if (index === -1) return null;

		if (key === "ArrowRight" || key === "ArrowDown") {
			return options[(index + 1) % options.length];
		}
		if (key === "ArrowLeft" || key === "ArrowUp") {
			return options[(index - 1 + options.length) % options.length];
		}
		if (key === "Home") return options[0];
		if (key === "End") return options[options.length - 1];

		return null;
	}

	// ---- Runtime listener ----

	function attachRuntimeListener(): () => void {
		const callback = (message: {
			type?: string;
			status?: CaptureStatus;
		}): false => {
			if (message?.type === "capture-status" && message.status) {
				renderStatus(message.status);
			}
			return false;
		};

		if (d.attachRuntimeListener) {
			return d.attachRuntimeListener(callback);
		}

		// Fallback for production
		const listener = callback;
		chrome.runtime.onMessage.addListener(listener);
		return () => {
			chrome.runtime.onMessage.removeListener(listener);
		};
	}

	// ---- Initialization ----

	async function initialize(): Promise<() => void> {
		const disposeRuntime = attachRuntimeListener();
		const mediaQuery = d.getMediaQuery!();

		const handleSystemThemeChange = (event: MediaQueryListEvent): void => {
			let currentPref: ThemePreference;
			update((s) => {
				currentPref = s.themePreference;
				return s;
			});
			if (currentPref! !== "system") return;
			patch({ effectiveTheme: event.matches ? "dark" : "light" });
			void d.applyTheme(event.matches ? "dark" : "light");
		};

		mediaQuery.addEventListener("change", handleSystemThemeChange);

		const pref = await d.getThemePreference();
		patch({ themePreference: pref });

		const resolvedTheme = await d.initTheme();
		patch({ effectiveTheme: resolvedTheme });

		const settings = await loadStoredPopupSettings();
		patch({
			smartScroll: settings.smoothStitching,
			exportFormat: settings.exportFormat,
			jpgQuality: settings.jpgQuality,
			askWhereToSave: settings.askWhereToSave,
		});

		try {
			const response = await d.sendMessage<{ status: CaptureStatus }>({
				type: "get-capture-status",
			});
			if (response.ok && response.data?.status) {
				patch({ captureStatus: response.data.status });
			}
		} catch {
			// No active capture on startup
		}

		try {
			const tabs = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			const tab = tabs[0];
			if (!tab?.url || !isCapturableUrl(tab.url)) {
				patch({
					canCapture: false,
					uncapturableReason: tab?.url
						? "This page cannot be captured by browser extension policy."
						: "No active tab found.",
				});
			}
		} catch {
			// Best-effort tab inspection
		}

		return () => {
			disposePolling();
			disposeRuntime();
			mediaQuery.removeEventListener("change", handleSystemThemeChange);
		};
	}

	// ---- Reactive wiring ----

	let lastRunning = false;
	const unsubscribe = subscribe((state) => {
		if (state.isRunning && !lastRunning) {
			startPolling();
		} else if (!state.isRunning && lastRunning) {
			stopPolling();
		}
		lastRunning = state.isRunning;
	});

	return {
		subscribe,
		startCapture,
		startAreaCapture,
		retryCapture,
		renderStatus,
		toggleTheme,
		applyThemeSelection,
		openSettings,
		closeSettings,
		handleFormatSelect,
		toggleAskWhereToSave,
		toggleSmoothStitching,
		handleResetSettings,
		handleOpenDownloads,
		getRadioSelection,
		setJpgQuality,
		initialize,
		saveOptionsFromUI,
		dispose: () => {
			unsubscribe();
			disposePolling();
		},
	};
}

export const popupStore = createPopupStore();
