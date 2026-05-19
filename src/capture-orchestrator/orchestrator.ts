import type {
	CaptureStatus,
	CaptureTilePayload,
	ExportOptions,
} from "../shared/messages";
import {
	JOB_TIMEOUT_MS,
	EXPORT_TIMEOUT_MS,
	PREFLIGHT_PROGRESS_WEIGHT,
} from "../shared/constants";
import type {
	JobDescriptor,
	PreflightProgress,
	TabCaptureAdapter,
	OffscreenAdapter,
	DownloadAdapter,
	StatusBroadcaster,
	OrchestratorOptions,
	Result,
	ExportResult,
	ExportMetadata,
} from "./types";
import { ok, err } from "./types";

function clamp(value: number, min = 0, max = 1): number {
	return Math.min(max, Math.max(min, value));
}

function formatSeconds(ms: number): string {
	return `${Math.round(Math.max(0, ms) / 1000)}s`;
}

interface ActiveJob {
	descriptor: JobDescriptor;
	timeoutId: ReturnType<typeof setTimeout> | null;
}

export class CaptureOrchestrator {
	private activeJob: ActiveJob | null = null;
	private status: CaptureStatus;
	private lastStatusUpdate = 0;
	private finalizingJobId: string | null = null;

	constructor(
		private tabCapture: TabCaptureAdapter,
		private offscreen: OffscreenAdapter,
		private downloads: DownloadAdapter,
		private broadcaster: StatusBroadcaster,
		private options: OrchestratorOptions = {
			jobTimeoutMs: JOB_TIMEOUT_MS,
			exportTimeoutMs: EXPORT_TIMEOUT_MS,
			preflightProgressWeight: PREFLIGHT_PROGRESS_WEIGHT,
			statusUpdateIntervalMs: 100,
		},
	) {
		this.status = {
			state: "idle",
			progress: 0,
			splitCount: 1,
			downloadedCount: 0,
			totalCount: 0,
		};
	}

	// ---- Status ----

	getStatus(): CaptureStatus {
		return { ...this.status };
	}

	private updateStatus(next: Partial<CaptureStatus>): void {
		this.status = { ...this.status, ...next };
		const now = Date.now();
		if (now - this.lastStatusUpdate >= this.options.statusUpdateIntervalMs) {
			this.lastStatusUpdate = now;
			this.broadcaster.broadcast({ ...this.status });
		}
	}

	private flushStatus(): void {
		this.lastStatusUpdate = 0;
		this.broadcaster.broadcast({ ...this.status });
	}

	// ---- Job lifecycle ----

	start(job: JobDescriptor): Result<void, string> {
		if (this.activeJob && this.status.state === "running") {
			return err("A capture job is already running.");
		}

		this.activeJob = {
			descriptor: job,
			timeoutId: null,
		};

		this.armJobTimeout(
			job.id,
			this.options.jobTimeoutMs,
			`Capture timed out after ${Math.round(this.options.jobTimeoutMs / 1000)}s.`,
		);

		this.updateStatus({
			state: "running",
			progress: 0,
			startedAt: Date.now(),
			pageUrl: undefined,
			splitCount: 1,
			downloadedCount: 0,
			totalCount: 0,
			phase: job.usesPreflight ? "preflight" : "capture",
			phaseProgress: 0,
			phaseDetail: job.usesPreflight ? "Preflight pass 0." : undefined,
			error: undefined,
			notice: undefined,
		});

		return ok(undefined);
	}

	abort(): void {
		if (!this.activeJob) return;
		this.clearJobTimeout();
		const jobId = this.activeJob.descriptor.id;
		void this.offscreen.clear(jobId).catch(() => undefined);
		this.activeJob = null;
		this.finalizingJobId = null;
		this.status = {
			state: "idle",
			progress: 0,
			splitCount: 1,
			downloadedCount: 0,
			totalCount: 0,
		};
		this.flushStatus();
	}

	// ---- Timeouts ----

	private clearJobTimeout(): void {
		if (!this.activeJob || this.activeJob.timeoutId === null) return;
		clearTimeout(this.activeJob.timeoutId);
		this.activeJob.timeoutId = null;
	}

	private armJobTimeout(
		jobId: string,
		timeoutMs: number,
		timeoutMessage: string,
	): void {
		if (!this.activeJob || this.activeJob.descriptor.id !== jobId) return;
		this.clearJobTimeout();
		const jobRef = this.activeJob;
		this.activeJob.timeoutId = setTimeout(() => {
			if (
				this.activeJob === jobRef &&
				this.activeJob?.descriptor.id === jobId
			) {
				void this.failJob(timeoutMessage);
			}
		}, timeoutMs);
	}

	// ---- Preflight ----

	onPreflightProgress(progress: PreflightProgress): void {
		if (
			!this.activeJob ||
			this.activeJob.descriptor.id !== progress.jobId ||
			this.status.state !== "running" ||
			!this.activeJob.descriptor.usesPreflight
		) {
			return;
		}

		const phaseProgress = clamp(progress.progress);
		const pass = Math.max(0, Math.floor(progress.pass));
		const maxPasses = Math.max(1, Math.floor(progress.maxPasses));
		const elapsedMs = Math.max(0, Math.floor(progress.elapsedMs));
		const maxDurationMs = Math.max(1000, Math.floor(progress.maxDurationMs));

		const detail =
			progress.detail?.trim() ||
			`Preflight pass ${Math.min(pass, maxPasses)}/${maxPasses} - ${formatSeconds(elapsedMs)}/${formatSeconds(maxDurationMs)}.`;

		const notice =
			progress.limitReason === "pass"
				? `Smart-scroll preflight reached pass cap (${maxPasses}). Capture continues with bounded height.`
				: progress.limitReason === "time"
					? `Smart-scroll preflight reached time cap (${formatSeconds(maxDurationMs)}). Capture continues with bounded height.`
					: this.status.notice;

		this.updateStatus({
			phase: "preflight",
			phaseProgress,
			phaseDetail: detail,
			progress: Math.min(
				this.options.preflightProgressWeight,
				phaseProgress * this.options.preflightProgressWeight,
			),
			notice,
		});
	}

	// ---- Tiles ----

	async onTile(
		jobId: string,
		tile: CaptureTilePayload,
		screenshot: string,
	): Promise<Result<{ isBlank: boolean }, string>> {
		const job = this.activeJob;
		if (
			!job ||
			job.descriptor.id !== jobId ||
			this.status.state !== "running"
		) {
			return err("Capture job is not active.");
		}

		try {
			const offscreenResponse = await this.offscreen.addTile(
				jobId,
				tile,
				screenshot,
			);

			if (
				!this.activeJob ||
				this.activeJob.descriptor.id !== jobId ||
				this.status.state !== "running"
			) {
				return err("Capture job is no longer active.");
			}

			if (offscreenResponse.isBlank) {
				return ok({ isBlank: true });
			}

			// Prefer explicit tile.complete when provided (set by content script
			// or synthetic test data). Otherwise compute from scroll position.
			let tileProgress: number;
			if (
				typeof tile.complete === "number" &&
				tile.complete >= 0 &&
				tile.complete <= 1
			) {
				tileProgress = clamp(tile.complete);
			} else {
				const needsHorizontalScroll = tile.totalWidth > tile.viewportWidth;
				const needsVerticalScroll = tile.totalHeight > tile.viewportHeight;
				const xProgress = needsHorizontalScroll
					? clamp(tile.x / (tile.totalWidth - tile.viewportWidth))
					: 0;
				const yProgress = needsVerticalScroll
					? clamp(tile.y / (tile.totalHeight - tile.viewportHeight))
					: 0;

				if (needsHorizontalScroll && needsVerticalScroll) {
					tileProgress = clamp((xProgress + yProgress) / 2);
				} else if (needsHorizontalScroll) {
					tileProgress = clamp(xProgress);
				} else if (needsVerticalScroll) {
					tileProgress = clamp(yProgress);
				} else {
					tileProgress = 1;
				}
			}

			this.updateStatus({
				progress: job.descriptor.usesPreflight
					? this.options.preflightProgressWeight +
						tileProgress * (1 - this.options.preflightProgressWeight)
					: tileProgress,
				splitCount: offscreenResponse.splitCount ?? this.status.splitCount,
				phase: "capture",
				phaseProgress: tileProgress,
				phaseDetail: undefined,
			});

			return ok({ isBlank: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.failJob(`Capture failed: ${message}`);
			return err("Tile capture failed.");
		}
	}

	// ---- Finish / Export ----

	async onFinished(jobId: string): Promise<Result<ExportResult[], string>> {
		if (this.finalizingJobId === jobId) {
			return err("Job is already being finalized.");
		}

		const job = this.activeJob;
		if (
			!job ||
			job.descriptor.id !== jobId ||
			this.status.state !== "running"
		) {
			return err("Capture job is not active.");
		}

		this.finalizingJobId = jobId;
		try {
			this.armJobTimeout(
				jobId,
				this.options.exportTimeoutMs,
				`Export timed out after ${Math.round(this.options.exportTimeoutMs / 1000)}s.`,
			);

			this.updateStatus({
				phase: "export",
				phaseProgress: 0,
				phaseDetail: "Compositing and preparing files...",
			});

			const metadata: ExportMetadata = {
				pageUrl: this.status.pageUrl ?? "",
				capturedAtIso: new Date().toISOString(),
			};

			const captures = await this.offscreen.export(
				jobId,
				job.descriptor.exportOptions,
				metadata,
			);

			if (!captures.length) {
				throw new Error("No screenshots were generated.");
			}

			this.updateStatus({
				totalCount: captures.length,
				splitCount: captures.length,
				progress: 1,
			});

			for (let i = 0; i < captures.length; i += 1) {
				const item = captures[i];
				const filename = this.addFilenameSuffix(
					job.descriptor.filename,
					i,
					item.extension,
					captures.length,
				);
				await this.downloads.download(
					{ dataUrl: item.dataUrl, extension: item.extension },
					filename,
					job.descriptor.downloadOptions.askWhereToSave,
				);
				this.updateStatus({
					downloadedCount: i + 1,
					phase: "export",
					phaseProgress: (i + 1) / captures.length,
					phaseDetail: `Downloading ${i + 1}/${captures.length}...`,
				});
			}

			await this.offscreen.clear(jobId).catch(() => undefined);
			this.clearJobTimeout();
			if (this.activeJob?.descriptor.id === jobId) {
				this.activeJob = null;
			}
			this.updateStatus({
				state: "done",
				phase: undefined,
				phaseProgress: undefined,
				phaseDetail: undefined,
			});
			this.flushStatus();
			return ok(captures);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.failJob(`Export failed: ${message}`);
			return err("Unable to export image.");
		} finally {
			if (this.finalizingJobId === jobId) {
				this.finalizingJobId = null;
			}
		}
	}

	async onFailed(jobId: string, reason: string): Promise<void> {
		if (this.finalizingJobId === jobId) return;
		if (
			!this.activeJob ||
			this.activeJob.descriptor.id !== jobId ||
			this.status.state !== "running"
		) {
			return;
		}
		await this.failJob(reason || "Capture stopped unexpectedly.");
	}

	private async failJob(message: string): Promise<void> {
		this.clearJobTimeout();
		if (this.activeJob) {
			await this.offscreen
				.clear(this.activeJob.descriptor.id)
				.catch(() => undefined);
		}
		this.activeJob = null;
		this.updateStatus({
			state: "error",
			error: message,
			phase: undefined,
			phaseProgress: undefined,
			phaseDetail: undefined,
		});
		this.flushStatus();
	}

	// ---- Helpers ----

	private addFilenameSuffix(
		filename: string,
		index: number,
		extension: ExportOptions["format"],
		totalCount: number,
	): string {
		if (totalCount <= 1 || index === 0) {
			return `${filename}.${extension}`;
		}
		return `${filename}-${index + 1}.${extension}`;
	}
}
