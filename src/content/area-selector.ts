import type { RuntimeResponse } from "../shared/messages";

const MIN_SELECTION_SIZE_PX = 8;
const OVERLAY_Z_INDEX = 10_000_000;

export interface VisibleAreaSelection {
	x: number;
	y: number;
	width: number;
	height: number;
	devicePixelRatio: number;
}

export function requestVisibleAreaSelection(): Promise<VisibleAreaSelection> {
	return new Promise((resolve, reject) => {
		const overlay = document.createElement("div");
		const box = document.createElement("div");
		overlay.id = "__emeraldpix_area_overlay__";
		overlay.style.cssText = `position:fixed;inset:0;z-index:${OVERLAY_Z_INDEX};cursor:crosshair;user-select:none;touch-action:none;background:rgba(0,0,0,0.12);`;
		box.style.cssText =
			"position:absolute;border:2px solid #10b981;background:rgba(16,185,129,0.14);box-shadow:0 0 0 99999px rgba(0,0,0,0.24);display:none;";
		overlay.appendChild(box);
		document.documentElement.appendChild(overlay);

		let startX = 0;
		let startY = 0;
		let dragging = false;

		const cleanup = () => {
			overlay.removeEventListener("pointerdown", onPointerDown);
			overlay.removeEventListener("pointermove", onPointerMove);
			overlay.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("keydown", onKeyDown, true);
			overlay.remove();
		};

		const getRect = (clientX: number, clientY: number) => {
			const left = Math.max(0, Math.min(startX, clientX));
			const top = Math.max(0, Math.min(startY, clientY));
			const right = Math.min(window.innerWidth, Math.max(startX, clientX));
			const bottom = Math.min(window.innerHeight, Math.max(startY, clientY));
			return {
				left,
				top,
				width: Math.max(0, right - left),
				height: Math.max(0, bottom - top),
			};
		};

		const paintRect = (clientX: number, clientY: number) => {
			const rect = getRect(clientX, clientY);
			box.style.display = "block";
			box.style.left = `${rect.left}px`;
			box.style.top = `${rect.top}px`;
			box.style.width = `${rect.width}px`;
			box.style.height = `${rect.height}px`;
		};

		const onPointerDown = (event: PointerEvent) => {
			dragging = true;
			startX = event.clientX;
			startY = event.clientY;
			overlay.setPointerCapture(event.pointerId);
			paintRect(event.clientX, event.clientY);
			event.preventDefault();
		};

		const onPointerMove = (event: PointerEvent) => {
			if (!dragging) {
				return;
			}
			paintRect(event.clientX, event.clientY);
			event.preventDefault();
		};

		const onPointerUp = (event: PointerEvent) => {
			if (!dragging) {
				return;
			}
			dragging = false;
			const rect = getRect(event.clientX, event.clientY);
			cleanup();
			if (
				rect.width < MIN_SELECTION_SIZE_PX ||
				rect.height < MIN_SELECTION_SIZE_PX
			) {
				reject(new Error("Area selection cancelled."));
				return;
			}
			resolve({
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
				devicePixelRatio: window.devicePixelRatio,
			});
		};

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				cleanup();
				reject(new Error("Area selection cancelled."));
			}
		};

		overlay.addEventListener("pointerdown", onPointerDown);
		overlay.addEventListener("pointermove", onPointerMove);
		overlay.addEventListener("pointerup", onPointerUp);
		window.addEventListener("keydown", onKeyDown, true);
	});
}
