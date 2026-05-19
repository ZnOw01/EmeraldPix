import type { CaptureStatus } from "../../shared/messages";
import type { StatusBroadcaster } from "../../capture-orchestrator/types";

export function createChromeStatusBroadcaster(): StatusBroadcaster {
	return {
		broadcast(status: CaptureStatus): void {
			void chrome.runtime
				.sendMessage({ type: "capture-status", status })
				.catch(() => undefined);
		},
	};
}
