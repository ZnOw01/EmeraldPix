import { describe, expect, it } from 'vitest';
import type { CaptureTilePayload } from '../src/shared/messages';
import { createDownloadRequest, getErrorMessage, validateTilePayload } from '../src/shared/utils';

// Minimal valid tile reused across validateTilePayload tests
const VALID_TILE: CaptureTilePayload = {
  x: 0,
  y: 0,
  complete: 0.5,
  viewportWidth: 800,
  viewportHeight: 600,
  screenshotWidth: 1600,
  screenshotHeight: 1200,
  totalWidth: 1600,
  totalHeight: 3000,
  devicePixelRatio: 2
};

describe('createDownloadRequest', () => {
  it('forces saveAs to false when askWhereToSave is disabled', () => {
    expect(createDownloadRequest('blob:test', 'shot.png', false)).toEqual({
      url: 'blob:test',
      filename: 'shot.png',
      conflictAction: 'uniquify',
      saveAs: false
    });
  });

  it('forces saveAs to true when askWhereToSave is enabled', () => {
    expect(createDownloadRequest('blob:test', 'shot.png', true)).toEqual({
      url: 'blob:test',
      filename: 'shot.png',
      conflictAction: 'uniquify',
      saveAs: true
    });
  });
});

describe('getErrorMessage', () => {
  it('returns the message of an Error instance', () => {
    expect(getErrorMessage(new Error('something went wrong'))).toBe('something went wrong');
  });

  it('coerces non-Error values to string', () => {
    expect(getErrorMessage('raw string error')).toBe('raw string error');
    expect(getErrorMessage(404)).toBe('404');
  });

  it('returns "Unknown error" for null and undefined', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });

  it('falls through to String() when Error has an empty message', () => {
    // Error with empty message is falsy so the instanceof guard is skipped
    expect(getErrorMessage(new Error(''))).toBe('Error');
  });
});

describe('validateTilePayload', () => {
  it('returns null for a fully valid payload', () => {
    expect(validateTilePayload(VALID_TILE)).toBeNull();
  });

  it('accepts valid optional crop fields', () => {
    const tile = { ...VALID_TILE, cropX: 0, cropY: 10, cropWidth: 400, cropHeight: 300 };
    expect(validateTilePayload(tile)).toBeNull();
  });

  it('rejects non-finite complete', () => {
    expect(validateTilePayload({ ...VALID_TILE, complete: NaN })).toMatch(/complete/);
    expect(validateTilePayload({ ...VALID_TILE, complete: Infinity })).toMatch(/complete/);
  });

  it('rejects negative x', () => {
    expect(validateTilePayload({ ...VALID_TILE, x: -1 })).toMatch(/`x`/);
  });

  it('rejects negative y', () => {
    expect(validateTilePayload({ ...VALID_TILE, y: -0.1 })).toMatch(/`y`/);
  });

  it('rejects zero viewportWidth', () => {
    expect(validateTilePayload({ ...VALID_TILE, viewportWidth: 0 })).toMatch(/viewportWidth/);
  });

  it('rejects zero viewportHeight', () => {
    expect(validateTilePayload({ ...VALID_TILE, viewportHeight: 0 })).toMatch(/viewportHeight/);
  });

  it('rejects zero screenshotWidth', () => {
    expect(validateTilePayload({ ...VALID_TILE, screenshotWidth: 0 })).toMatch(/screenshotWidth/);
  });

  it('rejects zero screenshotHeight', () => {
    expect(validateTilePayload({ ...VALID_TILE, screenshotHeight: -1 })).toMatch(
      /screenshotHeight/
    );
  });

  it('rejects negative cropX when provided', () => {
    expect(validateTilePayload({ ...VALID_TILE, cropX: -5 })).toMatch(/cropX/);
  });

  it('rejects negative cropY when provided', () => {
    expect(validateTilePayload({ ...VALID_TILE, cropY: -1 })).toMatch(/cropY/);
  });

  it('rejects zero cropWidth when provided', () => {
    expect(validateTilePayload({ ...VALID_TILE, cropWidth: 0 })).toMatch(/cropWidth/);
  });

  it('rejects zero cropHeight when provided', () => {
    expect(validateTilePayload({ ...VALID_TILE, cropHeight: 0 })).toMatch(/cropHeight/);
  });

  it('rejects zero totalWidth', () => {
    expect(validateTilePayload({ ...VALID_TILE, totalWidth: 0 })).toMatch(/totalWidth/);
  });

  it('rejects zero totalHeight', () => {
    expect(validateTilePayload({ ...VALID_TILE, totalHeight: 0 })).toMatch(/totalHeight/);
  });

  it('rejects zero devicePixelRatio', () => {
    expect(validateTilePayload({ ...VALID_TILE, devicePixelRatio: 0 })).toMatch(/devicePixelRatio/);
  });
});
