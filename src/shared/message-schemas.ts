import type { CaptureTilePayload, RuntimeResponse } from "./messages";
import type { PreflightProgress } from "../capture-orchestrator/types";
import {
	isFiniteNumber,
	isPositiveFiniteNumber,
	isNonNegativeFiniteNumber,
} from "./utils";
import type { Result } from "../capture-orchestrator/types";
import { ok, err } from "../capture-orchestrator/types";

export function validateCaptureTilePayload(
	value: unknown,
): Result<CaptureTilePayload, string> {
	if (!value || typeof value !== "object") {
		return err("Tile payload must be an object.");
	}
	const p = value as Record<string, unknown>;

	if (!isFiniteNumber(p.complete)) {
		return err("`complete` must be a finite number.");
	}
	if (!isNonNegativeFiniteNumber(p.x) || !isNonNegativeFiniteNumber(p.y)) {
		return err("`x`/`y` must be finite numbers >= 0.");
	}
	if (
		!isPositiveFiniteNumber(p.viewportWidth) ||
		!isPositiveFiniteNumber(p.viewportHeight)
	) {
		return err("`viewportWidth`/`viewportHeight` must be finite numbers > 0.");
	}
	if (
		!isPositiveFiniteNumber(p.screenshotWidth) ||
		!isPositiveFiniteNumber(p.screenshotHeight)
	) {
		return err(
			"`screenshotWidth`/`screenshotHeight` must be finite numbers > 0.",
		);
	}
	if (p.cropX !== undefined && !isNonNegativeFiniteNumber(p.cropX)) {
		return err("`cropX` must be a finite number >= 0 when provided.");
	}
	if (p.cropY !== undefined && !isNonNegativeFiniteNumber(p.cropY)) {
		return err("`cropY` must be a finite number >= 0 when provided.");
	}
	if (p.cropWidth !== undefined && !isPositiveFiniteNumber(p.cropWidth)) {
		return err("`cropWidth` must be a finite number > 0 when provided.");
	}
	if (p.cropHeight !== undefined && !isPositiveFiniteNumber(p.cropHeight)) {
		return err("`cropHeight` must be a finite number > 0 when provided.");
	}
	if (
		!isPositiveFiniteNumber(p.totalWidth) ||
		!isPositiveFiniteNumber(p.totalHeight)
	) {
		return err("`totalWidth`/`totalHeight` must be finite numbers > 0.");
	}
	if (!isPositiveFiniteNumber(p.devicePixelRatio)) {
		return err("`devicePixelRatio` must be a finite number > 0.");
	}

	return ok(p as unknown as CaptureTilePayload);
}

export function validatePreflightProgress(
	value: unknown,
): Result<PreflightProgress, string> {
	if (!value || typeof value !== "object") {
		return err("Preflight progress must be an object.");
	}
	const p = value as Record<string, unknown>;

	if (typeof p.jobId !== "string" || p.jobId.length === 0) {
		return err("`jobId` must be a non-empty string.");
	}
	if (!isFiniteNumber(p.progress)) {
		return err("`progress` must be a finite number.");
	}
	if (!isFiniteNumber(p.pass)) {
		return err("`pass` must be a finite number.");
	}
	if (!isFiniteNumber(p.maxPasses)) {
		return err("`maxPasses` must be a finite number.");
	}
	if (!isFiniteNumber(p.elapsedMs)) {
		return err("`elapsedMs` must be a finite number.");
	}
	if (!isFiniteNumber(p.maxDurationMs)) {
		return err("`maxDurationMs` must be a finite number.");
	}

	const limitReason = p.limitReason;
	if (
		limitReason !== undefined &&
		limitReason !== "pass" &&
		limitReason !== "time"
	) {
		return err('`limitReason` must be "pass", "time", or undefined.');
	}
	if (p.detail !== undefined && typeof p.detail !== "string") {
		return err("`detail` must be a string when provided.");
	}

	return ok({
		jobId: p.jobId,
		progress: p.progress,
		pass: p.pass,
		maxPasses: p.maxPasses,
		elapsedMs: p.elapsedMs,
		maxDurationMs: p.maxDurationMs,
		limitReason,
		detail: typeof p.detail === "string" ? p.detail : undefined,
	} as PreflightProgress);
}

export function validateCaptureFinished(
	value: unknown,
): Result<{ jobId: string }, string> {
	if (!value || typeof value !== "object") {
		return err("Message must be an object.");
	}
	const p = value as Record<string, unknown>;
	if (typeof p.jobId !== "string" || p.jobId.length === 0) {
		return err("`jobId` must be a non-empty string.");
	}
	return ok({ jobId: p.jobId });
}

export function validateCaptureFailed(
	value: unknown,
): Result<{ jobId: string; error?: string }, string> {
	if (!value || typeof value !== "object") {
		return err("Message must be an object.");
	}
	const p = value as Record<string, unknown>;
	if (typeof p.jobId !== "string" || p.jobId.length === 0) {
		return err("`jobId` must be a non-empty string.");
	}
	if (p.error !== undefined && typeof p.error !== "string") {
		return err("`error` must be a string when provided.");
	}
	return ok({
		jobId: p.jobId,
		error: typeof p.error === "string" ? p.error : undefined,
	});
}

export function validateRuntimeResponse(
	value: unknown,
): Result<RuntimeResponse<unknown>, string> {
	if (!value || typeof value !== "object") {
		return err("Response must be an object.");
	}
	const p = value as Record<string, unknown>;
	if (p.ok === true) {
		return ok({ ok: true, data: p.data } as RuntimeResponse<unknown>);
	}
	if (p.ok === false) {
		if (typeof p.error !== "string") {
			return err("`error` must be a string when ok is false.");
		}
		return ok({ ok: false, error: p.error } as RuntimeResponse<unknown>);
	}
	return err("`ok` must be a boolean.");
}
