import { describe, it, expect, vi, beforeEach } from "vitest";
import { CaptureOrchestrator } from "../src/capture-orchestrator/orchestrator";
import { ok, err } from "../src/capture-orchestrator/types";
import type {
	TabCaptureAdapter,
	OffscreenAdapter,
	DownloadAdapter,
	StatusBroadcaster,
	JobDescriptor,
	ExportResult,
	PreflightProgress,
} from "../src/capture-orchestrator/types";
import type {
	CaptureStatus,
	CaptureTilePayload,
	ExportOptions,
} from "../src/shared/messages";

// ---- Fake adapters for integration testing ----

class FakeTabCaptureAdapter implements TabCaptureAdapter {
	screenshots: Array<{ windowId: number }> = [];

	async capture(windowId: number): Promise<string> {
		this.screenshots.push({ windowId });
		return `data:image/png;base64,fake-${this.screenshots.length}`;
	}
}

class FakeOffscreenAdapter implements OffscreenAdapter {
	tiles: Array<{ jobId: string; tile: CaptureTilePayload; dataUrl: string }> =
		[];
	exports: Array<{ jobId: string; options: ExportOptions; metadata: unknown }> =
		[];
	clears: string[] = [];
	resets: string[] = [];

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
		options: ExportOptions,
		metadata: unknown,
	): Promise<ExportResult[]> {
		this.exports.push({ jobId, options, metadata });
		return [
			{
				dataUrl: `data:image/png;base64,exported-${jobId}`,
				extension: options.format,
			},
		];
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
		return [{ dataUrl, extension: "png" }];
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
		id: "integration-job-1",
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

function makeTile(complete: number): CaptureTilePayload {
	const totalWidth = 1920;
	const totalHeight = 2160;
	const viewportWidth = 1920;
	const viewportHeight = 1080;
	// Compute x/y that yield the intended progress with the orchestrator's formula:
	// progress = (xProgress + yProgress) / 2
	// For this test, totalWidth == viewportWidth so xProgress is always 1.
	// So: complete = (1 + yProgress) / 2  →  yProgress = 2*complete - 1
	const yProgress = Math.max(0, Math.min(1, 2 * complete - 1));
	const y = Math.round(yProgress * (totalHeight - viewportHeight));
	return {
		x: 0,
		y,
		complete,
		viewportWidth,
		viewportHeight,
		screenshotWidth: 1920,
		screenshotHeight: 1080,
		totalWidth,
		totalHeight,
		devicePixelRatio: 1,
	};
}

function createOrchestrator() {
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
			statusUpdateIntervalMs: 0,
		},
	);
	return { orchestrator, tabCapture, offscreen, downloads, broadcaster };
}

// ---- Integration tests ----

describe("CaptureOrchestrator integration", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("full capture flow: start → tile → tile → finish → download → done", async () => {
		const { orchestrator, offscreen, downloads, broadcaster } =
			createOrchestrator();
		const job = makeJob();

		// Start
		const startResult = orchestrator.start(job);
		expect(startResult.ok).toBe(true);
		expect(orchestrator.getStatus().state).toBe("running");

		// Tile 1 (33%)
		const tile1 = await orchestrator.onTile(
			job.id,
			makeTile(0.33),
			"data:fake1",
		);
		expect(tile1.ok).toBe(true);
		expect(offscreen.tiles).toHaveLength(1);
		expect(offscreen.tiles[0].dataUrl).toBe("data:fake1");
		expect(orchestrator.getStatus().progress).toBe(0.33);

		// Tile 2 (66%)
		const tile2 = await orchestrator.onTile(
			job.id,
			makeTile(0.66),
			"data:fake2",
		);
		expect(tile2.ok).toBe(true);
		expect(offscreen.tiles).toHaveLength(2);
		expect(orchestrator.getStatus().progress).toBe(0.66);

		// Tile 3 (100%)
		const tile3 = await orchestrator.onTile(job.id, makeTile(1), "data:fake3");
		expect(tile3.ok).toBe(true);
		expect(offscreen.tiles).toHaveLength(3);

		// Finish
		const finishResult = await orchestrator.onFinished(job.id);
		expect(finishResult.ok).toBe(true);
		const captures = (finishResult as { ok: true; value: ExportResult[] })
			.value;
		expect(captures).toHaveLength(1);
		expect(captures[0].extension).toBe("png");

		// Download
		expect(downloads.downloads).toHaveLength(1);
		expect(downloads.downloads[0].filename).toBe("test.png");

		// Status done
		expect(orchestrator.getStatus().state).toBe("done");
		expect(broadcaster.statuses.at(-1)?.state).toBe("done");

		// Offscreen cleared
		expect(offscreen.clears).toContain(job.id);
	});

	it("full flow with JPG export and multiple files", async () => {
		const { orchestrator, offscreen, downloads } = createOrchestrator();
		offscreen.export = async (
			jobId: string,
			options: ExportOptions,
			metadata: unknown,
		) => {
			offscreen.exports.push({ jobId, options, metadata });
			return [
				{ dataUrl: "data:1", extension: options.format },
				{ dataUrl: "data:2", extension: options.format },
			];
		};

		const job = makeJob({ exportOptions: { format: "jpg", jpgQuality: 0.8 } });

		orchestrator.start(job);
		await orchestrator.onTile(job.id, makeTile(1), "data:fake");
		await orchestrator.onFinished(job.id);

		expect(offscreen.exports).toHaveLength(1);
		expect(offscreen.exports[0].options.format).toBe("jpg");
		expect(offscreen.exports[0].options.jpgQuality).toBe(0.8);

		expect(downloads.downloads).toHaveLength(2);
		expect(downloads.downloads[0].filename).toBe("test.jpg");
		expect(downloads.downloads[1].filename).toBe("test-2.jpg");
	});

	it("full flow with preflight progress", async () => {
		const { orchestrator, broadcaster } = createOrchestrator();
		const job = makeJob({ usesPreflight: true });

		orchestrator.start(job);

		orchestrator.onPreflightProgress({
			jobId: job.id,
			progress: 0.5,
			pass: 1,
			maxPasses: 3,
			elapsedMs: 1000,
			maxDurationMs: 10000,
		});

		expect(orchestrator.getStatus().phase).toBe("preflight");
		expect(orchestrator.getStatus().progress).toBeCloseTo(0.15 * 0.5, 5);

		// After preflight, tile progress is weighted
		await orchestrator.onTile(job.id, makeTile(0.5), "data:fake");
		const expectedProgress = 0.15 + 0.5 * (1 - 0.15);
		expect(orchestrator.getStatus().progress).toBeCloseTo(expectedProgress, 5);
	});

	it("job fails on tile error and transitions to error state", async () => {
		const { orchestrator, offscreen, broadcaster } = createOrchestrator();
		offscreen.addTile = async () => {
			throw new Error("Canvas out of memory");
		};

		const job = makeJob();
		orchestrator.start(job);

		const tileResult = await orchestrator.onTile(
			job.id,
			makeTile(0.5),
			"data:fake",
		);
		expect(tileResult.ok).toBe(false);

		expect(orchestrator.getStatus().state).toBe("error");
		expect(orchestrator.getStatus().error).toContain("Canvas out of memory");
		expect(offscreen.clears).toContain(job.id);
		expect(broadcaster.statuses.at(-1)?.state).toBe("error");
	});

	it("job fails on export error and transitions to error state", async () => {
		const { orchestrator, offscreen } = createOrchestrator();
		offscreen.export = async () => {
			throw new Error("Export engine crashed");
		};

		const job = makeJob();
		orchestrator.start(job);
		await orchestrator.onTile(job.id, makeTile(1), "data:fake");

		const finishResult = await orchestrator.onFinished(job.id);
		expect(finishResult.ok).toBe(false);
		expect(orchestrator.getStatus().state).toBe("error");
		expect(orchestrator.getStatus().error).toContain("Export engine crashed");
	});

	it("job times out if not finished within timeout", async () => {
		const { orchestrator, offscreen } = createOrchestrator();
		const job = makeJob();

		orchestrator.start(job);
		await vi.advanceTimersByTimeAsync(6000);

		expect(orchestrator.getStatus().state).toBe("error");
		expect(orchestrator.getStatus().error).toContain("timed out");
		expect(offscreen.clears).toContain(job.id);
	});

	it("abort stops a running job mid-capture", async () => {
		const { orchestrator, offscreen } = createOrchestrator();
		const job = makeJob();

		orchestrator.start(job);
		await orchestrator.onTile(job.id, makeTile(0.5), "data:fake");

		orchestrator.abort();

		expect(orchestrator.getStatus().state).toBe("idle");
		expect(offscreen.clears).toContain(job.id);
	});

	it("ignores late tile after abort", async () => {
		const { orchestrator, offscreen } = createOrchestrator();
		const job = makeJob();

		orchestrator.start(job);
		orchestrator.abort();

		const result = await orchestrator.onTile(
			job.id,
			makeTile(0.5),
			"data:fake",
		);
		expect(result.ok).toBe(false);
		expect(offscreen.tiles).toHaveLength(0);
	});

	it("ignores finish for already-done job", async () => {
		const { orchestrator, offscreen } = createOrchestrator();
		const job = makeJob();

		orchestrator.start(job);
		await orchestrator.onTile(job.id, makeTile(1), "data:fake");
		const finish1 = await orchestrator.onFinished(job.id);
		expect(finish1.ok).toBe(true);

		const finish2 = await orchestrator.onFinished(job.id);
		expect(finish2.ok).toBe(false);
		expect(offscreen.exports).toHaveLength(1); // Only one export
	});

	it("ignores onFailed for non-active job", async () => {
		const { orchestrator } = createOrchestrator();

		await orchestrator.onFailed("nonexistent", "something broke");
		expect(orchestrator.getStatus().state).toBe("idle");
	});

	it("status broadcaster receives all state transitions", async () => {
		const { orchestrator, broadcaster } = createOrchestrator();
		const job = makeJob();

		orchestrator.start(job);
		expect(broadcaster.statuses.some((s) => s.state === "running")).toBe(true);

		await orchestrator.onTile(job.id, makeTile(1), "data:fake");
		await orchestrator.onFinished(job.id);

		expect(broadcaster.statuses.some((s) => s.state === "done")).toBe(true);
	});

	it("accepts pre-captured screenshots and forwards to offscreen", async () => {
		const { orchestrator, offscreen } = createOrchestrator();
		const job = makeJob({ windowId: 42 });

		orchestrator.start(job);
		await orchestrator.onTile(job.id, makeTile(0.5), "data:screenshot1");
		await orchestrator.onTile(job.id, makeTile(1), "data:screenshot2");

		// The orchestrator receives pre-captured dataUrls and passes them to offscreen
		expect(offscreen.tiles).toHaveLength(2);
		expect(offscreen.tiles[0].dataUrl).toBe("data:screenshot1");
		expect(offscreen.tiles[1].dataUrl).toBe("data:screenshot2");
	});
});
