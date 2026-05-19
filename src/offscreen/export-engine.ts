import type {
	ExportFile,
	ExportOptions,
	ExportFormat,
} from "../shared/messages";
import type { ScreenshotSlice } from "./canvas-compositor";

type JsPdfModule = typeof import("jspdf");

async function canvasToBlob(
	canvas: OffscreenCanvas | HTMLCanvasElement,
	format: ExportFormat,
	jpgQuality: number,
): Promise<Blob> {
	const mime = format === "jpg" ? "image/jpeg" : "image/png";
	const quality = format === "jpg" ? jpgQuality : undefined;

	if (
		typeof OffscreenCanvas !== "undefined" &&
		canvas instanceof OffscreenCanvas
	) {
		return canvas.convertToBlob({ type: mime, quality });
	}
	return new Promise<Blob>((resolve, reject) => {
		(canvas as HTMLCanvasElement).toBlob(
			(blob) => {
				if (blob) {
					resolve(blob);
					return;
				}
				reject(new Error("Unable to encode canvas blob."));
			},
			mime,
			quality,
		);
	});
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			if (typeof reader.result === "string") {
				resolve(reader.result);
			} else {
				reject(new Error("Unable to convert blob to data URL."));
			}
		};
		reader.onerror = () => reject(new Error("Unable to read blob."));
		reader.readAsDataURL(blob);
	});
}

export class ExportEngine {
	private jsPdfPromise: Promise<JsPdfModule> | null = null;

	constructor(private loadJsPdf: () => Promise<JsPdfModule>) {}

	private getJsPdf(): Promise<JsPdfModule> {
		if (!this.jsPdfPromise) {
			this.jsPdfPromise = this.loadJsPdf().catch((error) => {
				this.jsPdfPromise = null;
				throw error;
			});
		}
		return this.jsPdfPromise;
	}

	async exportAsRaster(
		slices: ScreenshotSlice[],
		options: ExportOptions,
	): Promise<ExportFile[]> {
		const blobs = await Promise.all(
			slices.map((s) =>
				canvasToBlob(s.canvas, options.format, options.jpgQuality),
			),
		);
		return this.exportAsRasterFromBlobs(blobs, options);
	}

	async exportAsPdf(slices: ScreenshotSlice[]): Promise<ExportFile[]> {
		const blobs = await Promise.all(
			slices.map((s) => canvasToBlob(s.canvas, "png", 1)),
		);
		return this.exportAsPdfFromBlobs(blobs, 0, 0);
	}

	async exportAsRasterFromBlobs(
		blobs: Blob[],
		options: ExportOptions,
	): Promise<ExportFile[]> {
		const files = await Promise.all(
			blobs.map(async (blob) => {
				return {
					dataUrl: await blobToDataUrl(blob),
					extension: options.format,
				} as ExportFile;
			}),
		);
		return files;
	}

	async exportAsPdfFromBlobs(
		blobs: Blob[],
		width: number,
		height: number,
	): Promise<ExportFile[]> {
		const { jsPDF } = await this.getJsPdf();
		let pdf: InstanceType<typeof jsPDF> | null = null;

		for (const blob of blobs) {
			const imageDataUrl = await blobToDataUrl(blob);
			// Each blob is a horizontal strip; for PDF we treat each as a page
			// We estimate dimensions from the blob or use the job dimensions
			const image = await fetch(imageDataUrl)
				.then((r) => r.blob())
				.then((b) => createImageBitmap(b));
			const pageWidth = image.width;
			const pageHeight = image.height;
			image.close();

			const orientation = pageWidth >= pageHeight ? "landscape" : "portrait";
			const pageSize: [number, number] = [pageWidth, pageHeight];

			if (!pdf) {
				pdf = new jsPDF({
					orientation,
					unit: "px",
					format: pageSize,
					compress: true,
				});
			} else {
				pdf.addPage(pageSize, orientation);
			}

			pdf.addImage(
				imageDataUrl,
				"PNG",
				0,
				0,
				pageWidth,
				pageHeight,
				undefined,
				"FAST",
			);
		}

		if (!pdf) {
			throw new Error("No data to export as PDF.");
		}

		const pdfBlob = pdf.output("blob");
		return [
			{
				dataUrl: await blobToDataUrl(pdfBlob),
				extension: "pdf",
			},
		];
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
		options: ExportOptions,
	): Promise<ExportFile[]> {
		const image = await fetch(dataUrl)
			.then((r) => r.blob())
			.then((blob) => createImageBitmap(blob));

		try {
			const scale = Math.max(1, area.devicePixelRatio || 1);
			const sx = Math.max(0, Math.round(area.x * scale));
			const sy = Math.max(0, Math.round(area.y * scale));
			const sw = Math.max(1, Math.round(area.width * scale));
			const sh = Math.max(1, Math.round(area.height * scale));
			const maxWidth = Math.max(1, image.width - sx);
			const maxHeight = Math.max(1, image.height - sy);
			const cropWidth = Math.min(sw, maxWidth);
			const cropHeight = Math.min(sh, maxHeight);

			if (typeof OffscreenCanvas !== "undefined") {
				const canvas = new OffscreenCanvas(cropWidth, cropHeight);
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("Unable to create canvas context.");
				ctx.drawImage(
					image,
					sx,
					sy,
					cropWidth,
					cropHeight,
					0,
					0,
					cropWidth,
					cropHeight,
				);

				const captures =
					options.format === "pdf"
						? await this.exportAsPdf([
								{
									canvas,
									ctx,
									left: 0,
									top: 0,
									right: cropWidth,
									bottom: cropHeight,
								},
							])
						: await this.exportAsRaster(
								[
									{
										canvas,
										ctx,
										left: 0,
										top: 0,
										right: cropWidth,
										bottom: cropHeight,
									},
								],
								options,
							);
				return captures;
			}

			const canvas = document.createElement("canvas");
			canvas.width = cropWidth;
			canvas.height = cropHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Unable to create canvas context.");
			ctx.drawImage(
				image,
				sx,
				sy,
				cropWidth,
				cropHeight,
				0,
				0,
				cropWidth,
				cropHeight,
			);

			const captures =
				options.format === "pdf"
					? await this.exportAsPdf([
							{
								canvas,
								ctx,
								left: 0,
								top: 0,
								right: cropWidth,
								bottom: cropHeight,
							},
						])
					: await this.exportAsRaster(
							[
								{
									canvas,
									ctx,
									left: 0,
									top: 0,
									right: cropWidth,
									bottom: cropHeight,
								},
							],
							options,
						);
			return captures;
		} finally {
			image.close();
		}
	}
}
