import { describe, expect, it } from 'vitest';
import {
  composePersistedPopupSettings,
  createDefaultPopupSettingsState,
  createPopupSettingsState
} from '../src/popup/settings-model';
import {
  DEFAULT_CAPTURE_OPTIONS,
  DEFAULT_DOWNLOAD_OPTIONS,
  DEFAULT_EXPORT_OPTIONS
} from '../src/shared/constants';

describe('popup settings model', () => {
  it('returns the expected defaults for the popup controls', () => {
    expect(createDefaultPopupSettingsState()).toEqual({
      askWhereToSave: DEFAULT_DOWNLOAD_OPTIONS.askWhereToSave,
      exportFormat: DEFAULT_EXPORT_OPTIONS.format,
      jpgQuality: DEFAULT_EXPORT_OPTIONS.jpgQuality,
      smoothStitching: DEFAULT_CAPTURE_OPTIONS.enableSmartScroll
    });
  });

  it('hydrates practical settings from persisted values', () => {
    expect(
      createPopupSettingsState({
        captureOptions: { enableSmartScroll: false },
        exportOptions: { format: 'jpg', jpgQuality: 0.65 },
        downloadOptions: { askWhereToSave: true }
      })
    ).toEqual({
      askWhereToSave: true,
      exportFormat: 'jpg',
      jpgQuality: 0.65,
      smoothStitching: false
    });
  });

  it('derives resolved persisted settings from the selected UI state', () => {
    const persisted = composePersistedPopupSettings({
      askWhereToSave: true,
      exportFormat: 'pdf',
      jpgQuality: 1.5,
      smoothStitching: false
    });

    expect(persisted.downloadOptions).toEqual({
      ...DEFAULT_DOWNLOAD_OPTIONS,
      askWhereToSave: true
    });
    expect(persisted.exportOptions).toEqual({
      ...DEFAULT_EXPORT_OPTIONS,
      format: 'pdf',
      jpgQuality: 1
    });
    expect(persisted.captureOptions).toEqual({
      ...DEFAULT_CAPTURE_OPTIONS,
      enableSmartScroll: false
    });
  });

  it('falls back to all defaults when sources are empty objects', () => {
    expect(createPopupSettingsState({})).toEqual(createDefaultPopupSettingsState());
  });

  it('falls back to all defaults when source sub-objects are null', () => {
    expect(
      createPopupSettingsState({ captureOptions: null, exportOptions: null, downloadOptions: null })
    ).toEqual(createDefaultPopupSettingsState());
  });

  it('clamps jpgQuality below 0.4 up to 0.4', () => {
    const persisted = composePersistedPopupSettings({
      askWhereToSave: false,
      exportFormat: 'jpg',
      jpgQuality: 0.1,
      smoothStitching: true
    });
    expect(persisted.exportOptions.jpgQuality).toBe(0.4);
  });

  it('falls back to the default jpgQuality when the value is NaN', () => {
    const persisted = composePersistedPopupSettings({
      askWhereToSave: false,
      exportFormat: 'jpg',
      jpgQuality: NaN,
      smoothStitching: true
    });
    expect(persisted.exportOptions.jpgQuality).toBe(DEFAULT_EXPORT_OPTIONS.jpgQuality);
  });
});
