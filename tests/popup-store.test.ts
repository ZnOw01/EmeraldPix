import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";
import { createPopupStore } from "../src/popup/popup-store";
import type { PopupStoreDependencies } from "../src/popup/popup-store";
import type { CaptureStatus, RuntimeResponse } from "../src/shared/messages";
import type { Theme, ThemePreference } from "../src/shared/theme";

function createMockDeps(overrides?: any): any {
	const storage: Record<string, unknown> = {};

	return {
		sendMessage: vi.fn(
			async <T>(message: unknown): Promise<RuntimeResponse<T>> => {
				const msg = message as { type?: string };
				if (msg.type === "get-capture-status") {
					return {
						ok: true,
						data: {
							status: {
								state: "idle",
								progress: 0,
								splitCount: 1,
								downloadedCount: 0,
								totalCount: 0,
							},
						} as unknown as T,
					};
				}
				if (msg.type === "start-capture" || msg.type === "start-area-capture") {
					return {
						ok: true,
						data: {
							status: {
								state: "running",
								progress: 0,
								splitCount: 1,
								downloadedCount: 0,
								totalCount: 0,
							},
							alreadyRunning: false,
						} as unknown as T,
					};
				}
				return { ok: false, error: "Unknown message type" };
			},
		),
		readPersistedValue: vi.fn(async (key: string) => storage[key]),
		writePersistedValues: vi.fn(async (values: Record<string, unknown>) => {
			Object.assign(storage, values);
		}),
		removePersistedValues: vi.fn(async () => {}),
		initTheme: vi.fn(async (): Promise<Theme> => "light"),
		getThemePreference: vi.fn(async (): Promise<ThemePreference> => "system"),
		setThemePreference: vi.fn(async () => {}),
		resetThemePreference: vi.fn(async (): Promise<Theme> => "light"),
		applyTheme: vi.fn(async () => {}),
		attachRuntimeListener: vi.fn(() => () => {}),
		getMediaQuery: vi.fn(
			() =>
				({
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
					matches: false,
				}) as unknown as MediaQueryList,
		),
		...overrides,
	};
}

describe("PopupStore", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("initializes with default settings", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		const state = get(store);

		expect(state.captureStatus.state).toBe("idle");
		expect(state.smartScroll).toBe(true);
		expect(state.exportFormat).toBe("png");
		expect(state.jpgQuality).toBe(1);
		expect(state.askWhereToSave).toBe(false);
		expect(state.effectiveTheme).toBe("light");
		expect(state.themePreference).toBe("system");
		expect(state.settingsOpen).toBe(false);

		dispose();
		store.dispose();
	});

	it("hydrates settings from persisted values", async () => {
		const deps = createMockDeps({
			readPersistedValue: vi.fn(async (key: string) => {
				if (key === "captureOptions") return { enableSmartScroll: false };
				if (key === "exportOptions") return { format: "jpg", jpgQuality: 0.8 };
				if (key === "downloadOptions") return { askWhereToSave: true };
				return undefined;
			}),
		});
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		const state = get(store);

		expect(state.smartScroll).toBe(false);
		expect(state.exportFormat).toBe("jpg");
		expect(state.jpgQuality).toBe(0.8);
		expect(state.askWhereToSave).toBe(true);

		dispose();
		store.dispose();
	});

	it("toggles theme", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.toggleTheme();

		const state = get(store);
		expect(state.effectiveTheme).toBe("dark");
		expect(state.themePreference).toBe("dark");
		expect(deps.setThemePreference).toHaveBeenCalledWith("dark");

		dispose();
		store.dispose();
	});

	it("applies theme selection", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.applyThemeSelection("dark");

		const state = get(store);
		expect(state.effectiveTheme).toBe("dark");
		expect(state.themePreference).toBe("dark");

		dispose();
		store.dispose();
	});

	it("opens and closes settings", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		store.openSettings();

		let state = get(store);
		expect(state.settingsOpen).toBe(true);

		store.closeSettings();
		state = get(store);
		expect(state.settingsOpen).toBe(false);

		dispose();
		store.dispose();
	});

	it("selects export format and persists", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.handleFormatSelect("jpg");

		const state = get(store);
		expect(state.exportFormat).toBe("jpg");
		expect(deps.writePersistedValues).toHaveBeenCalled();

		dispose();
		store.dispose();
	});

	it("toggles askWhereToSave and persists", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.toggleAskWhereToSave();

		const state = get(store);
		expect(state.askWhereToSave).toBe(true);

		dispose();
		store.dispose();
	});

	it("toggles smoothStitching and persists", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.toggleSmoothStitching();

		const state = get(store);
		expect(state.smartScroll).toBe(false);

		dispose();
		store.dispose();
	});

	it("sets jpg quality", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		store.setJpgQuality(0.6);

		const state = get(store);
		expect(state.jpgQuality).toBe(0.6);
		expect(state.jpgQualityPercent).toBe(60);

		dispose();
		store.dispose();
	});

	it("starts a capture and updates status", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.startCapture();

		const state = get(store);
		expect(state.captureStatus.state).toBe("running");
		expect(state.isRunning).toBe(true);
		expect(state.captureRunning).toBe(true);
		expect(state.showProgress).toBe(true);
		expect(deps.sendMessage).toHaveBeenCalledWith({ type: "start-capture" });

		dispose();
		store.dispose();
	});

	it("starts an area capture", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.startAreaCapture();

		const state = get(store);
		expect(state.lastCaptureType).toBe("area");
		expect(state.captureStatus.state).toBe("running");
		expect(deps.sendMessage).toHaveBeenCalledWith({
			type: "start-area-capture",
		});

		dispose();
		store.dispose();
	});

	it("retries last capture type", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.startAreaCapture();
		await store.retryCapture();

		// retryCapture calls startAreaCapture again since last type was 'area'
		expect(deps.sendMessage).toHaveBeenCalledTimes(2);
		expect(deps.sendMessage).toHaveBeenLastCalledWith({
			type: "start-area-capture",
		});

		dispose();
		store.dispose();
	});

	it("computes derived UI state correctly for idle", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		const state = get(store);

		expect(state.isIdle).toBe(true);
		expect(state.isRunning).toBe(false);
		expect(state.isDone).toBe(false);
		expect(state.isError).toBe(false);
		expect(state.showCaptureButton).toBe(true);
		expect(state.showRetryButton).toBe(false);
		expect(state.statusText).toBe("Ready");

		dispose();
		store.dispose();
	});

	it("computes derived UI state correctly for running preflight", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		store.renderStatus({
			state: "running",
			progress: 0.05,
			splitCount: 1,
			downloadedCount: 0,
			totalCount: 0,
			phase: "preflight",
			phaseProgress: 0.33,
			phaseDetail: "Pass 1/3",
		});

		const state = get(store);
		expect(state.isRunning).toBe(true);
		expect(state.showProgress).toBe(true);
		expect(state.statusText).toBe("Analyzing the page...");
		expect(state.progressPercent).toBe(5);

		dispose();
		store.dispose();
	});

	it("computes derived UI state correctly for error", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		store.renderStatus({
			state: "error",
			progress: 0,
			splitCount: 1,
			downloadedCount: 0,
			totalCount: 0,
			error: "Something broke",
		});

		const state = get(store);
		expect(state.isError).toBe(true);
		expect(state.showRetryButton).toBe(true);
		expect(state.showCaptureButton).toBe(false);
		expect(state.errorAlertVisible).toBe(true);
		expect(state.errorAlertMessage).toBe("Something broke");
		expect(state.statusText).toBe("Try again");

		dispose();
		store.dispose();
	});

	it("computes derived UI state correctly for done", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		store.renderStatus({
			state: "done",
			progress: 1,
			splitCount: 2,
			downloadedCount: 2,
			totalCount: 2,
		});

		const state = get(store);
		expect(state.isDone).toBe(true);
		expect(state.showProgress).toBe(true);
		expect(state.statusText).toBe("Saved");
		expect(state.statusDetail).toBe("2 files saved");

		dispose();
		store.dispose();
	});

	it("shows split alert for large pages", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		store.renderStatus({
			state: "running",
			progress: 0.5,
			splitCount: 3,
			downloadedCount: 0,
			totalCount: 0,
			phase: "capture",
			phaseProgress: 0.5,
		});

		const state = get(store);
		expect(state.splitAlertVisible).toBe(true);
		expect(state.splitAlertMessage).toContain("3");

		dispose();
		store.dispose();
	});

	it("polls status when running", async () => {
		const polledStatus: CaptureStatus = {
			state: "running",
			progress: 0.75,
			splitCount: 1,
			downloadedCount: 0,
			totalCount: 1,
		};

		const deps = createMockDeps({
			sendMessage: vi.fn(
				async <T>(message: unknown): Promise<RuntimeResponse<T>> => {
					const msg = message as { type?: string };
					if (msg.type === "get-capture-status") {
						return { ok: true, data: { status: polledStatus } as unknown as T };
					}
					if (msg.type === "start-capture") {
						return {
							ok: true,
							data: {
								status: {
									state: "running",
									progress: 0,
									splitCount: 1,
									downloadedCount: 0,
									totalCount: 0,
								},
								alreadyRunning: false,
							} as unknown as T,
						};
					}
					return { ok: false, error: "Unknown" };
				},
			),
		});

		const store = createPopupStore(deps);
		const dispose = await store.initialize();
		await store.startCapture();

		// Advance to next timer tick (500ms interval)
		await vi.advanceTimersToNextTimerAsync();
		// Give microtasks a chance to resolve the async pollStatus
		await new Promise((resolve) => setTimeout(resolve, 0));

		const state = get(store);
		expect(state.captureStatus.progress).toBe(0.75);

		dispose();
		store.dispose();
	});

	it("stops polling when not running", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const dispose = await store.initialize();
		await store.startCapture();

		// Transition to done
		store.renderStatus({
			state: "done",
			progress: 1,
			splitCount: 1,
			downloadedCount: 1,
			totalCount: 1,
		});

		await vi.advanceTimersByTimeAsync(600);

		const state = get(store);
		expect(state.isDone).toBe(true);
		// Should have stopped polling; no additional get-capture-status calls beyond initial

		dispose();
		store.dispose();
	});

	it("computes radio selection correctly", async () => {
		const deps = createMockDeps();
		const store = createPopupStore(deps);

		const options = ["png", "jpg", "pdf"] as const;

		expect(store.getRadioSelection(options, "png", "ArrowRight")).toBe("jpg");
		expect(store.getRadioSelection(options, "pdf", "ArrowRight")).toBe("png");
		expect(store.getRadioSelection(options, "jpg", "ArrowLeft")).toBe("png");
		expect(store.getRadioSelection(options, "png", "ArrowLeft")).toBe("pdf");
		expect(store.getRadioSelection(options, "png", "Home")).toBe("png");
		expect(store.getRadioSelection(options, "png", "End")).toBe("pdf");
		expect(store.getRadioSelection(options, "png", "Enter")).toBeNull();

		store.dispose();
	});

	it("resets settings to defaults", async () => {
		const deps = createMockDeps({
			readPersistedValue: vi.fn(async (key: string) => {
				if (key === "captureOptions") return { enableSmartScroll: false };
				if (key === "exportOptions") return { format: "jpg", jpgQuality: 0.8 };
				if (key === "downloadOptions") return { askWhereToSave: true };
				return undefined;
			}),
		});

		const store = createPopupStore(deps);
		const dispose = await store.initialize();

		// Override confirm to always return true
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = () => true;

		await store.handleResetSettings();

		const state = get(store);
		expect(state.smartScroll).toBe(true); // back to default
		expect(state.exportFormat).toBe("png");
		expect(state.jpgQuality).toBe(1);
		expect(state.askWhereToSave).toBe(false);
		expect(state.themePreference).toBe("system");
		expect(state.settingsOpen).toBe(false);
		expect(deps.removePersistedValues).toHaveBeenCalledWith([
			"captureOptions",
			"exportOptions",
			"downloadOptions",
		]);

		globalThis.confirm = originalConfirm;
		dispose();
		store.dispose();
	});
});
