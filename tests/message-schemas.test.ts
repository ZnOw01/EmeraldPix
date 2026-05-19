import { describe, it, expect } from "vitest";
import {
	validateCaptureTilePayload,
	validatePreflightProgress,
	validateCaptureFinished,
	validateCaptureFailed,
	validateRuntimeResponse,
} from "../src/shared/message-schemas";

function makeValidTile() {
	return {
		x: 0,
		y: 0,
		complete: 0.5,
		viewportWidth: 1920,
		viewportHeight: 1080,
		screenshotWidth: 1920,
		screenshotHeight: 1080,
		totalWidth: 1920,
		totalHeight: 2160,
		devicePixelRatio: 1,
	};
}

describe("message-schemas", () => {
	describe("validateCaptureTilePayload", () => {
		it("accepts a fully valid tile", () => {
			const result = validateCaptureTilePayload(makeValidTile());
			expect(result.ok).toBe(true);
		});

		it("rejects null", () => {
			const result = validateCaptureTilePayload(null);
			expect(result.ok).toBe(false);
		});

		it("rejects non-finite complete", () => {
			const result = validateCaptureTilePayload({
				...makeValidTile(),
				complete: NaN,
			});
			expect(result.ok).toBe(false);
			expect((result as { ok: false; error: string }).error).toContain(
				"complete",
			);
		});

		it("rejects negative x", () => {
			const result = validateCaptureTilePayload({ ...makeValidTile(), x: -1 });
			expect(result.ok).toBe(false);
		});

		it("rejects zero viewportWidth", () => {
			const result = validateCaptureTilePayload({
				...makeValidTile(),
				viewportWidth: 0,
			});
			expect(result.ok).toBe(false);
		});

		it("rejects invalid cropX", () => {
			const result = validateCaptureTilePayload({
				...makeValidTile(),
				cropX: -1,
			});
			expect(result.ok).toBe(false);
			expect((result as { ok: false; error: string }).error).toContain("cropX");
		});

		it("accepts missing optional crop fields", () => {
			const tile = makeValidTile();
			delete (tile as Record<string, unknown>).cropX;
			const result = validateCaptureTilePayload(tile);
			expect(result.ok).toBe(true);
		});

		it("rejects zero devicePixelRatio", () => {
			const result = validateCaptureTilePayload({
				...makeValidTile(),
				devicePixelRatio: 0,
			});
			expect(result.ok).toBe(false);
		});
	});

	describe("validatePreflightProgress", () => {
		it("accepts a valid preflight progress", () => {
			const result = validatePreflightProgress({
				jobId: "job-1",
				progress: 0.5,
				pass: 1,
				maxPasses: 3,
				elapsedMs: 1000,
				maxDurationMs: 10000,
			});
			expect(result.ok).toBe(true);
		});

		it("rejects missing jobId", () => {
			const result = validatePreflightProgress({
				progress: 0.5,
				pass: 1,
				maxPasses: 3,
				elapsedMs: 1000,
				maxDurationMs: 10000,
			});
			expect(result.ok).toBe(false);
		});

		it("rejects invalid limitReason", () => {
			const result = validatePreflightProgress({
				jobId: "job-1",
				progress: 0.5,
				pass: 1,
				maxPasses: 3,
				elapsedMs: 1000,
				maxDurationMs: 10000,
				limitReason: "invalid",
			});
			expect(result.ok).toBe(false);
		});

		it("accepts valid limitReason values", () => {
			const pass = validatePreflightProgress({
				jobId: "job-1",
				progress: 0.5,
				pass: 1,
				maxPasses: 3,
				elapsedMs: 1000,
				maxDurationMs: 10000,
				limitReason: "pass",
			});
			expect(pass.ok).toBe(true);

			const time = validatePreflightProgress({
				jobId: "job-1",
				progress: 0.5,
				pass: 1,
				maxPasses: 3,
				elapsedMs: 1000,
				maxDurationMs: 10000,
				limitReason: "time",
			});
			expect(time.ok).toBe(true);
		});
	});

	describe("validateCaptureFinished", () => {
		it("accepts valid finished message", () => {
			const result = validateCaptureFinished({ jobId: "job-1" });
			expect(result.ok).toBe(true);
		});

		it("rejects missing jobId", () => {
			const result = validateCaptureFinished({});
			expect(result.ok).toBe(false);
		});
	});

	describe("validateCaptureFailed", () => {
		it("accepts valid failed message", () => {
			const result = validateCaptureFailed({ jobId: "job-1", error: "Oops" });
			expect(result.ok).toBe(true);
		});

		it("accepts missing error", () => {
			const result = validateCaptureFailed({ jobId: "job-1" });
			expect(result.ok).toBe(true);
		});

		it("rejects non-string error", () => {
			const result = validateCaptureFailed({ jobId: "job-1", error: 123 });
			expect(result.ok).toBe(false);
		});
	});

	describe("validateRuntimeResponse", () => {
		it("accepts ok response", () => {
			const result = validateRuntimeResponse({ ok: true, data: { foo: 1 } });
			expect(result.ok).toBe(true);
		});

		it("accepts error response", () => {
			const result = validateRuntimeResponse({ ok: false, error: "failed" });
			expect(result.ok).toBe(true);
		});

		it("rejects missing ok", () => {
			const result = validateRuntimeResponse({ error: "failed" });
			expect(result.ok).toBe(false);
		});

		it("rejects error response without error string", () => {
			const result = validateRuntimeResponse({ ok: false });
			expect(result.ok).toBe(false);
		});
	});
});
