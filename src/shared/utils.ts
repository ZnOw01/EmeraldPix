import type { CaptureTilePayload } from './messages';

export const AREA_SELECTION_CANCELLED = 'Area selection cancelled.';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return error != null ? String(error) : 'Unknown error';
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function createDownloadRequest(
  url: string,
  filename: string,
  askWhereToSave: boolean
): chrome.downloads.DownloadOptions {
  return {
    url,
    filename,
    conflictAction: 'uniquify',
    // Always pass saveAs explicitly so the extension setting overrides
    // the browser's global "Ask where to save each file" preference.
    saveAs: askWhereToSave
  };
}

export function validateTilePayload(tile: CaptureTilePayload): string | null {
  if (!isFiniteNumber(tile.complete)) {
    return '`complete` must be a finite number.';
  }
  if (!isNonNegativeFiniteNumber(tile.x) || !isNonNegativeFiniteNumber(tile.y)) {
    return '`x`/`y` must be finite numbers >= 0.';
  }
  if (!isPositiveFiniteNumber(tile.viewportWidth) || !isPositiveFiniteNumber(tile.viewportHeight)) {
    return '`viewportWidth`/`viewportHeight` must be finite numbers > 0.';
  }
  if (
    !isPositiveFiniteNumber(tile.screenshotWidth) ||
    !isPositiveFiniteNumber(tile.screenshotHeight)
  ) {
    return '`screenshotWidth`/`screenshotHeight` must be finite numbers > 0.';
  }
  if (tile.cropX !== undefined && !isNonNegativeFiniteNumber(tile.cropX)) {
    return '`cropX` must be a finite number >= 0 when provided.';
  }
  if (tile.cropY !== undefined && !isNonNegativeFiniteNumber(tile.cropY)) {
    return '`cropY` must be a finite number >= 0 when provided.';
  }
  if (tile.cropWidth !== undefined && !isPositiveFiniteNumber(tile.cropWidth)) {
    return '`cropWidth` must be a finite number > 0 when provided.';
  }
  if (tile.cropHeight !== undefined && !isPositiveFiniteNumber(tile.cropHeight)) {
    return '`cropHeight` must be a finite number > 0 when provided.';
  }
  if (!isPositiveFiniteNumber(tile.totalWidth) || !isPositiveFiniteNumber(tile.totalHeight)) {
    return '`totalWidth`/`totalHeight` must be finite numbers > 0.';
  }
  if (!isPositiveFiniteNumber(tile.devicePixelRatio)) {
    return '`devicePixelRatio` must be a finite number > 0.';
  }
  return null;
}
