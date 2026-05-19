import type {
	CaptureTilePayload,
	ExportOptions,
	RuntimeResponse,
} from "../../shared/messages";
import { getErrorMessage } from "../../shared/utils";
import type {
	ExportResult,
	VisibleAreaSelection,
	OffscreenAdapter,
	ExportMetadata,
} from "../../capture-orchestrator/types";

export function createChromeOffscreenAdapter(): OffscreenAdapter {
	async function sendMessage<T>(message: unknown): Promise<T> {
		const response = (await chrome.runtime.sendMessage(
			message,
		)) as RuntimeResponse<T>;
		if (!response.ok) {
			throw new Error(response.error || "Offscreen operation failed.");
		}
		return response.data as T;
	}

	return {
		async reset(jobId: string): Promise<void> {
			await chrome.runtime.sendMessage({ type: "offscreen-reset", jobId });
		},

		async addTile(
			jobId: string,
			tile: CaptureTilePayload,
			dataUrl: string,
		): Promise<{ splitCount: number }> {
			return sendMessage<{ splitCount: number }>({
				type: "offscreen-add-tile",
				jobId,
				tile,
				dataUrl,
			});
		},

		async export(
			jobId: string,
			options: ExportOptions,
			metadata: ExportMetadata,
		): Promise<ExportResult[]> {
			const result = await sendMessage<{ captures: ExportResult[] }>({
				type: "offscreen-export",
				jobId,
				options,
				metadata,
			});
			return result.captures;
		},

		async clear(jobId: string): Promise<void> {
			await chrome.runtime.sendMessage({ type: "offscreen-clear", jobId });
		},

		async exportVisibleArea(
			dataUrl: string,
			area: VisibleAreaSelection,
			options: ExportOptions,
		): Promise<ExportResult[]> {
			const result = await sendMessage<{ captures: ExportResult[] }>({
				type: "offscreen-export-visible-area",
				dataUrl,
				area,
				options,
			});
			return result.captures;
		},
	};
}
