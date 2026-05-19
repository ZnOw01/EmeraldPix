import { describe, it, expect, vi, beforeEach } from "vitest";
import { CaptureOrchestrator } from "../src/capture-orchestrator/orchestrator";
import type {
	TabCaptureAdapter,
	OffscreenAdapter,
	DownloadAdapter,
	StatusBroadcaster,
	JobDescriptor,
	ExportResult,
	PreflightProgress,
} from "../src/capture-orchestrator/types";
import type { CaptureStatus, CaptureTilePayload } from "../src/shared/messages";

// ---- Fakes ----

class FakeTabCaptureAdapter implements TabCaptureAdapter {
	async capture(_windowId: number): Promise<string> {
		return "data:image/png;base64,fake";
	}
}

class FakeOffscreenAdapter implements OffscreenAdapter {
	tiles: Array<{ jobId: string; tile: CaptureTilePayload; dataUrl: string }> =
		[];
	exports: Array<{ jobId: string }> = [];
	clears: string[] = [];
	resets: string[] = [];
	visibleAreaExports: Array<{
		dataUrl: string;
		area: {
			x: number;
			y: number;
			width: number;
			height: number;
			devicePixelRatio: number;
		};
	}> = [];

	async reset(jobId: string): Promise<void> {
		this.resets.push(jobId);
	}

	async addTile(
		jobId: string,
		tile: CaptureTilePayload,
		dataUrl: string,
	): Promise<{ splitCount: number }> {
		this.tiles.push({ jobId, tile, dataUrl });
		return { splitCount: 1 };
	}

	async export(
		jobId: string,
		_options: unknown,
		_metadata: unknown,
	): Promise<ExportResult[]> {
		this.exports.push({ jobId });
		return [{ dataUrl: "data:image/png;base64,exported", extension: "png" }];
	}

	async clear(jobId: string): Promise<void> {
		this.clears.push(jobId);
	}

	async exportVisibleArea(
		dataUrl: string,
		area: {
			x: number;
			y: number;
			width: number;
			height: number;
			devicePixelRatio: number;
		},
	): Promise<ExportResult[]> {
		this.visibleAreaExports.push({ dataUrl, area });
		return [{ dataUrl: "data:image/png;base64,cropped", extension: "png" }];
	}
}

class FakeDownloadAdapter implements DownloadAdapter {
	downloads: Array<{
		file: { dataUrl: string; extension: string };
		filename: string;
		askWhereToSave: boolean;
	}> = [];

	async download(
		file: { dataUrl: string; extension: string },
		filename: string,
		askWhereToSave: boolean,
	): Promise<void> {
		this.downloads.push({ file, filename, askWhereToSave });
	}
}

class FakeStatusBroadcaster implements StatusBroadcaster {
	statuses: CaptureStatus[] = [];
	broadcast(status: CaptureStatus): void {
		this.statuses.push({ ...status });
	}
}

// ---- Fixtures ----

function makeJob(overrides?: Partial<JobDescriptor>): JobDescriptor {
	return {
		id: "test-job-1",
		tabId: 1,
		windowId: 1,
		filename: "test",
		options: {
			enableSmartScroll: false,
			lazyLoadWaitMs: 180,
			settleFrames: 2,
			heightGrowthThresholdPx: 48,
			maxExtraHeightPx: 30000,
			maxCaptureHeightPx: 80000,
		},
		exportOptions: { format: "png", jpgQuality: 1 },
		downloadOptions: { askWhereToSave: false },
		usesPreflight: false,
		...overrides,
	};
}

function makeTile(overrides?: Partial<CaptureTilePayload>): CaptureTilePayload {
	return {
		x: 0,
		y: 0,
		complete: 0.5,
		viewportWidth: 1920,
		viewportHeight: 1080,
		screenshotWidth: 1920,
		screenshotHeight: 1080,
		totalWidth: 1920,
		totalHeight: 2160,
		devicePixelRatio: 1,
		...overrides,
	};
}

function makeOrchestrator() {
	const tabCapture = new FakeTabCaptureAdapter();
	const offscreen = new FakeOffscreenAdapter();
	const downloads = new FakeDownloadAdapter();
	const broadcaster = new FakeStatusBroadcaster();
	const orchestrator = new CaptureOrchestrator(
		tabCapture,
		offscreen,
		downloads,
		broadcaster,
		{
			jobTimeoutMs: 5000,
			exportTimeoutMs: 5000,
			preflightProgressWeight: 0.15,
			statusUpdateIntervalMs: 0, // disable throttling for tests
		},
	);
	return { orchestrator, tabCapture, offscreen, downloads, broadcaster };
}

// ---- Tests ----

describe("CaptureOrchestrator", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("starts a job and transitions to running", () => {
		const { orchestrator, broadcaster } = makeOrchestrator();
		const job = makeJob();

		const result = orchestrator.start(job);

		expect(result.ok).toBe(true);
		const status = orchestrator.getStatus();
		expect(status.state).toBe("running");
		expect(status.progress).toBe(0);
		expect(broadcaster.statuses.length).toBeGreaterThan(0);
		expect(broadcaster.statuses.at(-1)?.state).toBe("running");
	});

	it("refuses to start when a job is already running", () => {
		const { orchestrator } = makeOrchestrator();
		orchestrator.start(makeJob());
		const result = orchestrator.start(makeJob({ id: "test-job-2" }));

		expect(result.ok).toBe(false);
		expect((result as { ok: false; error: string }).error).toBe(
			"A capture job is already running.",
		);
	});

	it("processes a tile and updates progress", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());

		const tile = makeTile({ complete: 0.5 });
		const result = await orchestrator.onTile("test-job-1", tile, "data:fake");

		expect(result.ok).toBe(true);
		expect(offscreen.tiles).toHaveLength(1);
		expect(offscreen.tiles[0].dataUrl).toBe("data:fake");
		expect(orchestrator.getStatus().progress).toBe(0.5);
	});

	it("ignores tiles for a non-active job", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());

		const result = await orchestrator.onTile(
			"wrong-id",
			makeTile(),
			"data:fake",
		);

		expect(result.ok).toBe(false);
		expect(offscreen.tiles).toHaveLength(0);
	});

	it("finalizes a job: export + download + done", async () => {
		const { orchestrator, offscreen, downloads } = makeOrchestrator();
		orchestrator.start(makeJob());
		await orchestrator.onTile(
			"test-job-1",
			makeTile({ complete: 1 }),
			"data:fake",
		);

		const result = await orchestrator.onFinished("test-job-1");

		expect(result.ok).toBe(true);
		const captures = (result as { ok: true; value: ExportResult[] }).value;
		expect(captures).toHaveLength(1);
		expect(offscreen.exports).toHaveLength(1);
		expect(offscreen.clears).toContain("test-job-1");
		expect(downloads.downloads).toHaveLength(1);
		expect(downloads.downloads[0].filename).toBe("test.png");
		expect(orchestrator.getStatus().state).toBe("done");
	});

	it("adds filename suffix when there are multiple captures", async () => {
		const { orchestrator, offscreen, downloads } = makeOrchestrator();
		offscreen.export = async () => [
			{ dataUrl: "data:1", extension: "png" },
			{ dataUrl: "data:2", extension: "png" },
		];

		orchestrator.start(makeJob());
		await orchestrator.onFinished("test-job-1");

		expect(downloads.downloads[0].filename).toBe("test.png");
		expect(downloads.downloads[1].filename).toBe("test-2.png");
	});

	it("fails a job on error", async () => {
		const { orchestrator, broadcaster } = makeOrchestrator();
		orchestrator.start(makeJob());

		await orchestrator.onFailed("test-job-1", "Something broke");

		expect(orchestrator.getStatus().state).toBe("error");
		expect(orchestrator.getStatus().error).toBe("Something broke");
		expect(broadcaster.statuses.at(-1)?.state).toBe("error");
	});

	it("aborts a running job and clears offscreen", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());
		await orchestrator.onTile("test-job-1", makeTile(), "data:fake");

		orchestrator.abort();

		expect(orchestrator.getStatus().state).toBe("idle");
		expect(offscreen.clears).toContain("test-job-1");
	});

	it("ignores tiles after abort", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());
		orchestrator.abort();

		const result = await orchestrator.onTile(
			"test-job-1",
			makeTile(),
			"data:fake",
		);

		expect(result.ok).toBe(false);
		expect(offscreen.tiles).toHaveLength(0);
	});

	it("applies preflight progress correctly", () => {
		const { orchestrator } = makeOrchestrator();
		orchestrator.start(makeJob({ usesPreflight: true }));

		orchestrator.onPreflightProgress({
			jobId: "test-job-1",
			progress: 0.5,
			pass: 1,
			maxPasses: 3,
			elapsedMs: 1000,
			maxDurationMs: 10000,
		});

		const status = orchestrator.getStatus();
		expect(status.phase).toBe("preflight");
		expect(status.progress).toBeCloseTo(0.15 * 0.5, 5);
	});

	it("ignores preflight progress for non-preflight jobs", () => {
		const { orchestrator } = makeOrchestrator();
		orchestrator.start(makeJob({ usesPreflight: false }));

		orchestrator.onPreflightProgress({
			jobId: "test-job-1",
			progress: 0.5,
			pass: 1,
			maxPasses: 3,
			elapsedMs: 1000,
			maxDurationMs: 10000,
		});

		expect(orchestrator.getStatus().phase).toBe("capture");
	});

	it("ignores preflight progress for wrong job id", () => {
		const { orchestrator } = makeOrchestrator();
		orchestrator.start(makeJob({ usesPreflight: true }));

		orchestrator.onPreflightProgress({
			jobId: "wrong-id",
			progress: 0.5,
			pass: 1,
			maxPasses: 3,
			elapsedMs: 1000,
			maxDurationMs: 10000,
		});

		expect(orchestrator.getStatus().phaseProgress).toBe(0);
	});

	it("times out a job after the configured timeout", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());

		await vi.advanceTimersByTimeAsync(6000);

		expect(orchestrator.getStatus().state).toBe("error");
		expect(orchestrator.getStatus().error).toContain("timed out");
		expect(offscreen.clears).toContain("test-job-1");
	});

	it("does not time out a job that finished before the timeout", async () => {
		const { orchestrator } = makeOrchestrator();
		orchestrator.start(makeJob());
		await orchestrator.onFinished("test-job-1");

		await vi.advanceTimersByTimeAsync(6000);

		expect(orchestrator.getStatus().state).toBe("done");
	});

	it("handles offscreen export failure gracefully", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		offscreen.export = async () => {
			throw new Error("Canvas explosion");
		};

		orchestrator.start(makeJob());
		const result = await orchestrator.onFinished("test-job-1");

		expect(result.ok).toBe(false);
		expect(orchestrator.getStatus().state).toBe("error");
		expect(orchestrator.getStatus().error).toContain("Canvas explosion");
	});

	it("ignores finish for a non-active job", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());

		const result = await orchestrator.onFinished("wrong-id");

		expect(result.ok).toBe(false);
		expect(offscreen.exports).toHaveLength(0);
	});

	it("ignores duplicate finalize calls for the same job", async () => {
		const { orchestrator, offscreen } = makeOrchestrator();
		orchestrator.start(makeJob());
		await orchestrator.onFinished("test-job-1");

		const result = await orchestrator.onFinished("test-job-1");

		expect(result.ok).toBe(false);
		expect(offscreen.exports).toHaveLength(1); // still only one export
	});

	it("computes progress with preflight weight for preflight jobs", async () => {
		const { orchestrator } = makeOrchestrator();
		orchestrator.start(makeJob({ usesPreflight: true }));

		orchestrator.onPreflightProgress({
			jobId: "test-job-1",
			progress: 1,
			pass: 3,
			maxPasses: 3,
			elapsedMs: 3000,
			maxDurationMs: 10000,
		});

		const tile = makeTile({ complete: 0.5 });
		await orchestrator.onTile("test-job-1", tile, "data:fake");

		const status = orchestrator.getStatus();
		expect(status.progress).toBeCloseTo(0.15 + 0.5 * (1 - 0.15), 5);
	});
});
