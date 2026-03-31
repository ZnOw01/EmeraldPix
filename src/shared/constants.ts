/**
 * Shared constants between background service worker and popup UI.
 * This file centralizes default values to avoid duplication.
 */

import type { CaptureOptions, DownloadOptions, ExportOptions } from './messages';

/**
 * Default capture options - used by both service worker and popup
 */
export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  enableSmartScroll: true,
  lazyLoadWaitMs: 180,
  settleFrames: 2,
  heightGrowthThresholdPx: 48,
  maxExtraHeightPx: 30000,
  maxCaptureHeightPx: 80000
};

/**
 * Default export options
 */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'png',
  jpgQuality: 1
};

/**
 * Default download options
 */
export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  askWhereToSave: false
};

/**
 * Capture timing constants
 */
export const JOB_TIMEOUT_MS = 180_000;
export const EXPORT_TIMEOUT_MS = 900_000;
export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 120_000;
export const OFFSCREEN_IDLE_CLOSE_MS = 20_000;

/**
 * Capture visible tab rate limiting
 */
export const CAPTURE_VISIBLE_TAB_MIN_INTERVAL_MS = 1000;
export const CAPTURE_VISIBLE_TAB_MAX_RETRIES = 5;
export const CAPTURE_VISIBLE_TAB_BACKOFF_BASE_MS = 350;
export const CAPTURE_VISIBLE_TAB_BACKOFF_MAX_MS = 4000;

/**
 * Progress weights
 */
export const PREFLIGHT_PROGRESS_WEIGHT = 0.15;

/**
 * URL validation patterns
 */
export const CAPTURE_PROTOCOLS = ['http://', 'https://', 'file://'];
export const BLOCKED_URLS = [/^chrome:/i, /^chrome-extension:/i, /^edge:/i, /^about:/i];
export const BLOCKED_HTTP_URLS = [/^https?:\/\/chrome\.google\.com\//i];
