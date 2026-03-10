import type { CaptureTilePayload } from './messages';

export const AREA_SELECTION_CANCELLED = 'Area selection cancelled.';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? 'Unknown error');
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

export function validateTilePayload(tile: CaptureTilePayload): string | null {
  if (!isFiniteNumber(tile.complete)) {
    return '`complete` must be a finite number.';
  }
  if (!isNonNegativeFiniteNumber(tile.x) || !isNonNegativeFiniteNumber(tile.y)) {
    return '`x`/`y` must be finite numbers >= 0.';
  }
  if (!isPositiveFiniteNumber(tile.windowWidth)) {
    return '`windowWidth` must be a finite number > 0.';
  }
  if (tile.windowHeight !== undefined && !isPositiveFiniteNumber(tile.windowHeight)) {
    return '`windowHeight` must be a finite number > 0 when provided.';
  }
  if (!isPositiveFiniteNumber(tile.totalWidth) || !isPositiveFiniteNumber(tile.totalHeight)) {
    return '`totalWidth`/`totalHeight` must be finite numbers > 0.';
  }
  if (!isPositiveFiniteNumber(tile.devicePixelRatio)) {
    return '`devicePixelRatio` must be a finite number > 0.';
  }
  return null;
}
