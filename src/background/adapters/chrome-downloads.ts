import type { ExportFile } from "../../shared/messages";
import { getErrorMessage } from "../../shared/utils";
import type { DownloadAdapter } from "../../capture-orchestrator/types";
import { DOWNLOAD_COMPLETION_TIMEOUT_MS } from "../../shared/constants";
import { createDownloadRequest } from "../../shared/utils";

export function createChromeDownloadAdapter(): DownloadAdapter {
	return {
		async download(
			file: ExportFile,
			filename: string,
			askWhereToSave: boolean,
		): Promise<void> {
			const downloadId = await chrome.downloads.download(
				createDownloadRequest(file.dataUrl, filename, askWhereToSave),
			);
			if (typeof downloadId !== "number") {
				throw new Error("Download did not start.");
			}
			await waitForDownloadCompletion(downloadId);
		},
	};
}

async function waitForDownloadCompletion(downloadId: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			finalizeError(
				new Error(`Download ${downloadId} did not complete in time.`),
			);
		}, DOWNLOAD_COMPLETION_TIMEOUT_MS);

		const cleanup = () => {
			clearTimeout(timer);
			chrome.downloads.onChanged.removeListener(onChanged);
		};

		const finalizeSuccess = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};

		const finalizeError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const onChanged = (delta: chrome.downloads.DownloadDelta) => {
			if (delta.id !== downloadId) return;
			if (delta.state?.current === "complete") {
				finalizeSuccess();
				return;
			}
			if (delta.state?.current === "interrupted" || delta.error?.current) {
				const code = delta.error?.current;
				finalizeError(
					new Error(
						`Download ${downloadId} interrupted${code ? `: ${code}` : "."}`,
					),
				);
			}
		};

		chrome.downloads.onChanged.addListener(onChanged);
		void chrome.downloads
			.search({ id: downloadId })
			.then((items) => {
				const current = items[0];
				if (!current) {
					finalizeError(new Error(`Download ${downloadId} was not found.`));
					return;
				}
				if (current.state === "complete") {
					finalizeSuccess();
					return;
				}
				if (current.state === "interrupted") {
					finalizeError(
						new Error(
							`Download ${downloadId} interrupted${current.error ? `: ${current.error}` : "."}`,
						),
					);
				}
			})
			.catch((error) => {
				finalizeError(
					new Error(
						`Unable to inspect download ${downloadId}: ${getErrorMessage(error)}`,
					),
				);
			});
	});
}
