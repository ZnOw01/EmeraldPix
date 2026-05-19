import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobManager } from "../src/offscreen/job-manager";
import type { CompositorJob } from "../src/offscreen/canvas-compositor";

function createFakeStrip(
	width = 100,
	height = 100,
): NonNullable<CompositorJob["front"]> {
	const canvas = {
		width,
		height,
		convertToBlob: vi.fn(),
	} as unknown as OffscreenCanvas;
	return {
		canvas,
		ctx: {} as unknown as OffscreenCanvasRenderingContext2D,
		heightUsed: 0,
	};
}

describe("JobManager", () => {
	let manager: JobManager;

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		manager = new JobManager(5000, 1000); // 5s TTL, 1s purge interval
	});

	afterEach(() => {
		manager.dispose();
		vi.useRealTimers();
	});

	it("creates a new job when none exists", () => {
		const job = manager.getOrCreateJob("job-1");
		expect(job.blobs).toEqual([]);
		expect(job.front).toBeNull();
		expect(job.back).toBeNull();
	});

	it("returns the same job for repeated accesses", () => {
		const job1 = manager.getOrCreateJob("job-1");
		const strip = createFakeStrip();
		job1.front = strip;

		const job2 = manager.getOrCreateJob("job-1");
		expect(job2.front).toBe(strip);
	});

	it("clears a job and releases buffer resources", () => {
		const strip = createFakeStrip();
		const job = manager.getOrCreateJob("job-1");
		job.front = strip;

		manager.clearJob("job-1");

		expect(strip.canvas.width).toBe(1);
		expect(strip.canvas.height).toBe(1);
		const jobAfter = manager.getOrCreateJob("job-1");
		expect(jobAfter.blobs).toEqual([]);
		expect(jobAfter.front).toBeNull();
	});

	it("resets a job to empty state", () => {
		const job = manager.getOrCreateJob("job-1");
		job.front = createFakeStrip();
		job.blobs.push(new Blob([]));

		manager.resetJob("job-1");

		const jobAfter = manager.getOrCreateJob("job-1");
		expect(jobAfter.blobs).toEqual([]);
		expect(jobAfter.front).toBeNull();
	});

	it("purges stale jobs automatically on interval", async () => {
		const strip = createFakeStrip();
		const job = manager.getOrCreateJob("job-1");
		job.front = strip;

		manager.startStalePurgeInterval();

		// Advance past TTL
		await vi.advanceTimersByTimeAsync(6000);

		// Canvas should be cleared
		expect(strip.canvas.width).toBe(1);
		expect(strip.canvas.height).toBe(1);
	});

	it("does not purge fresh jobs", async () => {
		const strip = createFakeStrip();
		const job = manager.getOrCreateJob("job-1");
		job.front = strip;

		manager.startStalePurgeInterval();

		// Advance less than TTL
		await vi.advanceTimersByTimeAsync(3000);

		expect(strip.canvas.width).toBe(100);
		expect(strip.canvas.height).toBe(100);
	});

	it("refreshes timestamp on access", async () => {
		const strip = createFakeStrip();
		const job = manager.getOrCreateJob("job-1");
		job.front = strip;

		manager.startStalePurgeInterval();

		// Advance almost to TTL
		await vi.advanceTimersByTimeAsync(4000);

		// Access refreshes timestamp
		manager.getOrCreateJob("job-1");

		// Advance another almost-TTL — total 8s, but access at 4s refreshed it
		await vi.advanceTimersByTimeAsync(4000);

		// Should still be alive (last access was at 4s, TTL is 5s)
		expect(strip.canvas.width).toBe(100);
	});

	it("cleanup releases all resources", () => {
		const s1 = createFakeStrip(100, 100);
		const s2 = createFakeStrip(200, 200);

		const j1 = manager.getOrCreateJob("job-1");
		j1.front = s1;

		const j2 = manager.getOrCreateJob("job-2");
		j2.front = s2;

		manager.cleanup();

		expect(s1.canvas.width).toBe(1);
		expect(s2.canvas.width).toBe(1);
	});

	it("dispose stops purge interval and cleans up", () => {
		manager.startStalePurgeInterval();
		manager.dispose();

		// Should not throw and should be safe to create new jobs
		const job = manager.getOrCreateJob("job-new");
		expect(job.blobs).toEqual([]);
		expect(job.front).toBeNull();
	});
});
