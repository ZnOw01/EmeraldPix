import type { CaptureTilePayload } from "../shared/messages";
import {
	isPositiveFiniteNumber,
	isNonNegativeFiniteNumber,
	validateTilePayload,
} from "../shared/utils";

type CanvasLike = OffscreenCanvas | HTMLCanvasElement;
type Canvas2DContext =
	| OffscreenCanvasRenderingContext2D
	| CanvasRenderingContext2D;

export interface CreateCanvasResult {
	canvas: CanvasLike;
	ctx: Canvas2DContext;
}

export interface ScreenshotSlice {
	canvas: CanvasLike;
	ctx: Canvas2DContext;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export type CreateCanvasFn = (
	width: number,
	height: number,
) => CreateCanvasResult;

const MAX_STRIP_HEIGHT = 8192;

function createCanvasDefault(
	width: number,
	height: number,
): CreateCanvasResult {
	if ("OffscreenCanvas" in self) {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Unable to create offscreen 2D context.");
		}
		return { canvas, ctx };
	}

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("Unable to create canvas context.");
	}
	return { canvas, ctx };
}

interface ActiveStrip {
	canvas: CanvasLike;
	ctx: Canvas2DContext;
	heightUsed: number;
}

export interface CompositorJob {
	front: ActiveStrip | null;
	back: ActiveStrip | null;
	blobs: Blob[];
	canvasWidth: number;
	totalHeight: number;
	firstY: number;
}

export class CanvasCompositor {
	constructor(
		private getJob: (jobId: string) => CompositorJob,
		private createCanvas: CreateCanvasFn = createCanvasDefault,
	) {}

	private createStrip(width: number): ActiveStrip {
		const { canvas, ctx } = this.createCanvas(width, MAX_STRIP_HEIGHT);
		return { canvas, ctx, heightUsed: 0 };
	}

	async decodeImage(dataUrl: string): Promise<ImageBitmap> {
		const blob = await (await fetch(dataUrl)).blob();
		return createImageBitmap(blob);
	}

	private isBlank(image: ImageBitmap): boolean {
		const { canvas, ctx } = this.createCanvas(10, 10);
		ctx.drawImage(image, 0, 0, 10, 10);
		const data = ctx.getImageData(0, 0, 10, 10).data;
		
		// Check if all pixels are either fully transparent or pure white
		// We use a small sample (10x10) for performance.
		let allWhite = true;
		let allTransparent = true;
		
		for (let i = 0; i < data.length; i += 4) {
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			const a = data[i + 3];
			
			if (a !== 0) {
				allTransparent = false;
			}
			if (r !== 255 || g !== 255 || b !== 255 || a !== 255) {
				allWhite = false;
			}
			
			if (!allWhite && !allTransparent) return false;
		}
		
		return allWhite || allTransparent;
	}

	async addTile(
		jobId: string,
		tile: CaptureTilePayload,
		dataUrl: string,
	): Promise<{ splitCount: number; blobsCount: number; isBlank?: boolean }> {
		const job = this.getJob(jobId);
		const image = await this.decodeImage(dataUrl);

		try {
			if (this.isBlank(image)) {
				return {
					splitCount: job.blobs.length + (job.front ? 1 : 0),
					blobsCount: job.blobs.length,
					isBlank: true,
				};
			}

			const tileValidationError = validateTilePayload(tile);
			if (tileValidationError) {
				throw new Error(`Invalid tile payload: ${tileValidationError}`);
			}
			if (
				!isPositiveFiniteNumber(image.width) ||
				!isPositiveFiniteNumber(image.height)
			) {
				throw new Error("Invalid captured tile dimensions.");
			}

			const nominalScaleX = tile.devicePixelRatio;
			const nominalScaleY = tile.devicePixelRatio;

			const expectedWidth = tile.screenshotWidth * nominalScaleX;
			const expectedHeight = tile.screenshotHeight * nominalScaleY;
			const widthDiff = Math.abs(image.width - expectedWidth);
			const heightDiff = Math.abs(image.height - expectedHeight);
			const scaleX =
				widthDiff > 2 ? image.width / tile.screenshotWidth : nominalScaleX;
			const scaleY =
				heightDiff > 2 ? image.height / tile.screenshotHeight : nominalScaleY;

			if (!isPositiveFiniteNumber(scaleX) || !isPositiveFiniteNumber(scaleY)) {
				throw new Error("Invalid tile scaling factors.");
			}

			const cropX = Math.max(0, Math.round((tile.cropX ?? 0) * scaleX));
			const cropY = Math.max(0, Math.round((tile.cropY ?? 0) * scaleY));
			const rawCropWidth = (tile.cropWidth ?? tile.viewportWidth) * scaleX;
			const rawCropHeight = (tile.cropHeight ?? tile.viewportHeight) * scaleY;
			const cropWidth = Math.min(
				image.width - cropX,
				Math.max(1, Math.round(rawCropWidth)),
			);
			const cropHeight = Math.min(
				image.height - cropY,
				Math.max(1, Math.round(rawCropHeight)),
			);

			const destinationX = Math.round(tile.x * scaleX);
			const destinationY = Math.round(tile.y * scaleY);
			const scaledTotalWidth = Math.ceil(tile.totalWidth * scaleX);
			const scaledTotalHeight = Math.ceil(tile.totalHeight * scaleY);

			if (
				!isNonNegativeFiniteNumber(destinationX) ||
				!isNonNegativeFiniteNumber(destinationY) ||
				!isPositiveFiniteNumber(scaledTotalWidth) ||
				!isPositiveFiniteNumber(scaledTotalHeight) ||
				!isPositiveFiniteNumber(cropWidth) ||
				!isPositiveFiniteNumber(cropHeight)
			) {
				throw new Error("Invalid scaled tile dimensions.");
			}

			// Initialize job on first tile
			if (!job.front) {
				job.canvasWidth = scaledTotalWidth;
				job.totalHeight = 0;
				job.firstY = destinationY;
				job.front = this.createStrip(scaledTotalWidth);
			}

			const relativeY = destinationY - job.firstY;
			const stripOffset =
				Math.floor(relativeY / MAX_STRIP_HEIGHT) * MAX_STRIP_HEIGHT;
			const localY = relativeY - stripOffset;

			// If this tile belongs to a new strip, flush the current one
			while (
				job.front &&
				localY + cropHeight > job.front.heightUsed + MAX_STRIP_HEIGHT
			) {
				await this.flushFront(job);
			}

			if (!job.front) {
				job.front = this.createStrip(job.canvasWidth);
			}

			// Draw the tile
			job.front.ctx.drawImage(
				image,
				cropX,
				cropY,
				cropWidth,
				cropHeight,
				destinationX,
				localY,
				cropWidth,
				cropHeight,
			);

			job.front.heightUsed = Math.max(
				job.front.heightUsed,
				localY + cropHeight,
			);
			job.totalHeight = Math.max(job.totalHeight, relativeY + cropHeight);

			return {
				splitCount: job.blobs.length + (job.front ? 1 : 0),
				blobsCount: job.blobs.length,
			};
		} finally {
			image.close();
		}
	}

	private async canvasToBlob(canvas: CanvasLike): Promise<Blob> {
		if (canvas instanceof OffscreenCanvas) {
			return canvas.convertToBlob({ type: "image/png" });
		}
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Canvas toBlob failed"));
			}, "image/png");
		});
	}

	private async flushFront(job: CompositorJob): Promise<void> {
		if (!job.front) return;

		// Crop the strip to actual used height before converting to blob
		const usedHeight = job.front.heightUsed;
		if (usedHeight > 0 && usedHeight < MAX_STRIP_HEIGHT) {
			// Create a smaller canvas with just the used portion
			const { canvas: cropped, ctx } = this.createCanvas(
				job.canvasWidth,
				usedHeight,
			);
			ctx.drawImage(job.front.canvas, 0, 0);
			const blob = await this.canvasToBlob(cropped);
			job.blobs.push(blob);
			// Release GPU memory
			cropped.width = 1;
			cropped.height = 1;
		} else if (usedHeight >= MAX_STRIP_HEIGHT) {
			const blob = await this.canvasToBlob(job.front.canvas);
			job.blobs.push(blob);
		}

		// Release old front buffer
		job.front.canvas.width = 1;
		job.front.canvas.height = 1;

		// Swap back buffer to front, or clear if no back
		if (job.back) {
			job.front = job.back;
			job.back = null;
		} else {
			job.front = null;
		}
	}

	async finalize(jobId: string): Promise<{
		blobs: Blob[];
		width: number;
		height: number;
	}> {
		const job = this.getJob(jobId);
		await this.flushFront(job);

		const result = {
			blobs: [...job.blobs],
			width: job.canvasWidth,
			height: job.totalHeight,
		};

		// Clear any remaining back buffer
		if (job.back) {
			job.back.canvas.width = 1;
			job.back.canvas.height = 1;
			job.back = null;
		}

		return result;
	}
}
