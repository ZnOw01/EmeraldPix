import type { CompositorJob } from "./canvas-compositor";

export class JobManager {
	private jobs = new Map<string, CompositorJob>();
	private timestamps = new Map<string, number>();
	private purgeTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private ttlMs: number,
		private purgeIntervalMs: number,
	) {}

	startStalePurgeInterval(): void {
		if (this.purgeTimer) return;
		this.purgeTimer = setInterval(() => {
			this.purgeStale();
		}, this.purgeIntervalMs);
	}

	stopStalePurgeInterval(): void {
		if (this.purgeTimer) {
			clearInterval(this.purgeTimer);
			this.purgeTimer = null;
		}
	}

	purgeStale(): void {
		const now = Date.now();
		for (const [id, timestamp] of this.timestamps) {
			if (now - timestamp > this.ttlMs) {
				this.clearJob(id);
			}
		}
	}

	getOrCreateJob(jobId: string): CompositorJob {
		this.purgeStale();

		let job = this.jobs.get(jobId);
		if (!job) {
			job = {
				front: null,
				back: null,
				blobs: [],
				canvasWidth: 0,
				totalHeight: 0,
				firstY: 0,
			};
			this.jobs.set(jobId, job);
		}
		this.timestamps.set(jobId, Date.now());
		return job;
	}

	clearJob(jobId: string): void {
		const job = this.jobs.get(jobId);
		if (job) {
			if (job.front) {
				job.front.canvas.width = 1;
				job.front.canvas.height = 1;
				job.front = null;
			}
			if (job.back) {
				job.back.canvas.width = 1;
				job.back.canvas.height = 1;
				job.back = null;
			}
			job.blobs = [];
		}
		this.jobs.delete(jobId);
		this.timestamps.delete(jobId);
	}

	resetJob(jobId: string): void {
		this.purgeStale();
		this.clearJob(jobId);
		this.jobs.set(jobId, {
			front: null,
			back: null,
			blobs: [],
			canvasWidth: 0,
			totalHeight: 0,
			firstY: 0,
		});
		this.timestamps.set(jobId, Date.now());
	}

	cleanup(): void {
		this.stopStalePurgeInterval();
		for (const [, job] of this.jobs) {
			if (job.front) {
				job.front.canvas.width = 1;
				job.front.canvas.height = 1;
				job.front = null;
			}
			if (job.back) {
				job.back.canvas.width = 1;
				job.back.canvas.height = 1;
				job.back = null;
			}
			job.blobs = [];
		}
		this.jobs.clear();
		this.timestamps.clear();
	}

	dispose(): void {
		this.cleanup();
	}
}
