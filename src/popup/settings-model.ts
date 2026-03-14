import type {
  CaptureOptions,
  DownloadOptions,
  ExportFormat,
  ExportOptions
} from '../shared/messages';
import {
  DEFAULT_CAPTURE_OPTIONS,
  DEFAULT_DOWNLOAD_OPTIONS,
  DEFAULT_EXPORT_OPTIONS
} from '../shared/constants';

export interface PopupSettingsState {
  askWhereToSave: boolean;
  exportFormat: ExportFormat;
  jpgQuality: number;
  smoothStitching: boolean;
}

export interface PopupSettingsSources {
  captureOptions?: Partial<CaptureOptions> | null;
  exportOptions?: Partial<ExportOptions> | null;
  downloadOptions?: Partial<DownloadOptions> | null;
}

const VALID_EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'jpg', 'pdf'];

function isValidExportFormat(value: unknown): value is ExportFormat {
  return VALID_EXPORT_FORMATS.includes(value as ExportFormat);
}

function clampJpgQuality(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXPORT_OPTIONS.jpgQuality;
  }

  return Math.max(0.4, Math.min(1, value));
}

export function createDefaultPopupSettingsState(): PopupSettingsState {
  return {
    askWhereToSave: DEFAULT_DOWNLOAD_OPTIONS.askWhereToSave,
    exportFormat: DEFAULT_EXPORT_OPTIONS.format,
    jpgQuality: DEFAULT_EXPORT_OPTIONS.jpgQuality,
    smoothStitching: DEFAULT_CAPTURE_OPTIONS.enableSmartScroll
  };
}

export function createPopupSettingsState(sources: PopupSettingsSources): PopupSettingsState {
  const defaults = createDefaultPopupSettingsState();
  const captureOptions = sources.captureOptions ?? {};
  const exportOptions = sources.exportOptions ?? {};
  const downloadOptions = sources.downloadOptions ?? {};

  return {
    askWhereToSave:
      typeof downloadOptions.askWhereToSave === 'boolean'
        ? downloadOptions.askWhereToSave
        : defaults.askWhereToSave,
    exportFormat: isValidExportFormat(exportOptions.format)
      ? exportOptions.format
      : defaults.exportFormat,
    jpgQuality: clampJpgQuality(exportOptions.jpgQuality ?? defaults.jpgQuality),
    smoothStitching:
      typeof captureOptions.enableSmartScroll === 'boolean'
        ? captureOptions.enableSmartScroll
        : defaults.smoothStitching
  };
}

export function composePersistedPopupSettings(state: PopupSettingsState): {
  captureOptions: CaptureOptions;
  exportOptions: ExportOptions;
  downloadOptions: DownloadOptions;
} {
  return {
    captureOptions: {
      ...DEFAULT_CAPTURE_OPTIONS,
      enableSmartScroll: state.smoothStitching
    },
    exportOptions: {
      ...DEFAULT_EXPORT_OPTIONS,
      format: state.exportFormat,
      jpgQuality: clampJpgQuality(state.jpgQuality)
    },
    downloadOptions: {
      ...DEFAULT_DOWNLOAD_OPTIONS,
      askWhereToSave: state.askWhereToSave
    }
  };
}
