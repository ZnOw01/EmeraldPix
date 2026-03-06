
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    CaptureOptions,
    CaptureStatus,
    ExportFormat,
    ExportOptions,
    RuntimeResponse
  } from '../shared/messages';
  import {
    readPersistedValue,
    removePersistedValues,
    writePersistedValues
  } from '../shared/persisted-store';
  import {
    DEFAULT_CAPTURE_OPTIONS,
    DEFAULT_EXPORT_OPTIONS
  } from '../shared/constants';
  import { formatMessage } from '../shared/format-message';
  import {
    initTheme,
    getCurrentTheme,
    toggleTheme as toggleThemeSetting,
    resolveEffectiveTheme,
    type Theme
  } from '../shared/theme';

  declare const __APP_VERSION__: string;
  declare const __BUILD_ID__: string;
  declare const __DEV_MODE__: boolean;

  interface StartCaptureData {
    status: CaptureStatus;
    alreadyRunning: boolean;
  }

  const APP_VERSION = __APP_VERSION__;
  const DEV_BUILD_LABEL = __BUILD_ID__.replace(/[:.]/g, '-');
  const COPY: Record<string, string> = {
    'app.title': 'EmeraldPix',
    'errors.unknownError': 'Something went wrong. Try again.',
    'formats.jpg': 'JPG',
    'formats.pdf': 'PDF',
    'formats.png': 'PNG',
    'popup.actions.capture': 'Page',
    'popup.actions.captureArea': 'Area',
    'popup.actions.capturing': 'Capturing...',
    'popup.actions.closeSettings': 'Close settings',
    'popup.actions.openDownloads': 'Open downloads',
    'popup.actions.openSettings': 'Open settings',
    'popup.actions.resetSettings': 'Reset to defaults',
    'popup.actions.retry': 'Try again',
    'popup.actions.toggleThemeDark': 'Switch to dark mode',
    'popup.actions.toggleThemeLight': 'Switch to light mode',
    'popup.alerts.largePage': '{count} {fileWord}.',
    'popup.alerts.statusUnavailable': 'Status unavailable.',
    'popup.errors.couldNotStart': 'Could not start capture.',
    'popup.errors.invalidStartStatus': 'Capture did not return a valid status.',
    'popup.misc.appVersion': 'v{version}',
    'popup.modal.confirmReset': 'Reset all settings to their defaults?',
    'popup.modal.title': 'Settings',
    'popup.quick.format': 'Format',
    'popup.quick.smartScroll': 'Smart scroll',
    'popup.status.analyzingPage': 'Analyzing the page...',
    'popup.status.captureComplete': 'Saved',
    'popup.status.captureFailed': 'Try again',
    'popup.status.capturingPage': 'Capturing the page...',
    'popup.status.downloadProgress': '{downloaded}/{total} files saved',
    'popup.status.progressComplete': '{progress}% complete',
    'popup.status.readyToCapture': 'Ready',
    'popup.status.savingCapture': 'Saving your capture...'
  };

  const IDLE_STATUS: CaptureStatus = {
    state: 'idle',
    progress: 0,
    splitCount: 1,
    downloadedCount: 0,
    totalCount: 0
  };

  let pollTimer: number | undefined;
  let pollInFlight = false;

  let captureStatus: CaptureStatus = { ...IDLE_STATUS };
  let progressPercent = 0;
  let statusText = COPY['popup.status.readyToCapture'];
  let statusDetail = '';
  let screenReaderStatus = '';

  let splitAlertVisible = false;
  let splitAlertMessage = '';
  let noticeAlertVisible = false;
  let noticeAlertMessage = '';
  let errorAlertVisible = false;
  let errorAlertMessage = '';

  let showCaptureButton = true;
  let showRetryButton = false;
  let captureRunning = false;

  let smartScroll = DEFAULT_CAPTURE_OPTIONS.enableSmartScroll;
  let exportFormat: ExportFormat = DEFAULT_EXPORT_OPTIONS.format;

  let settingsOpen = false;
  let theme: Theme = 'light';
  let effectiveTheme: 'light' | 'dark' = 'light';

  let settingsTriggerEl: HTMLButtonElement | null = null;
  let modalEl: HTMLDivElement | null = null;
  let previousFocusedEl: HTMLElement | null = null;

  $: captureButtonLabel = captureRunning
    ? t('popup.actions.capturing')
    : t('popup.actions.capture');
  $: themeToggleLabel =
    effectiveTheme === 'light'
      ? t('popup.actions.toggleThemeDark')
      : t('popup.actions.toggleThemeLight');
  $: screenReaderStatus = statusDetail ? `${statusText}. ${statusDetail}` : statusText;
  $: showProgress = captureStatus.state === 'running' || captureStatus.state === 'done';

  function t(
    id: string,
    values: Record<string, string | number | boolean | Date | null | undefined> = {},
    fallback = id
  ): string {
    return formatMessage(COPY[id] ?? fallback, values);
  }

  function pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return count === 1 ? singular : plural;
  }

  function formatSavedFiles(count: number): string {
    return formatMessage('{count} {noun} saved', {
      count,
      noun: pluralize(count, 'file')
    });
  }

  function formatLargePageNotice(count: number): string {
    return t('popup.alerts.largePage', {
      count,
      fileWord: pluralize(count, 'file')
    });
  }

  function setCaptureRunning(running: boolean): void {
    captureRunning = running;
  }

  function updateThemeIcon(): void {
    effectiveTheme = resolveEffectiveTheme(theme);
  }

  async function toggleTheme(): Promise<void> {
    theme = await toggleThemeSetting();
    updateThemeIcon();
  }

  function getModalFocusableElements(): HTMLElement[] {
    if (!modalEl) {
      return [];
    }

    return Array.from(
      modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }

  async function openSettings(): Promise<void> {
    if (settingsOpen) {
      return;
    }

    previousFocusedEl = document.activeElement as HTMLElement | null;
    settingsOpen = true;
    await tick();

    const firstFocusable = getModalFocusableElements()[0];
    firstFocusable?.focus();
  }

  function closeSettings(): void {
    if (!settingsOpen) {
      return;
    }

    settingsOpen = false;
    const restoreTarget = previousFocusedEl ?? settingsTriggerEl;
    restoreTarget?.focus();
  }

  function handleModalOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      closeSettings();
    }
  }

  function handleModalKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = getModalFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && settingsOpen) {
      closeSettings();
    }
  }

  function composeCaptureOptionsFromUI(): CaptureOptions {
    return {
      ...DEFAULT_CAPTURE_OPTIONS,
      enableSmartScroll: smartScroll
    };
  }

  function composeExportOptionsFromUI(): ExportOptions {
    return {
      ...DEFAULT_EXPORT_OPTIONS,
      format: exportFormat,
      jpgQuality: DEFAULT_EXPORT_OPTIONS.jpgQuality
    };
  }

  async function saveOptionsFromUI(): Promise<void> {
    await writePersistedValues({
      captureOptions: composeCaptureOptionsFromUI(),
      exportOptions: composeExportOptionsFromUI()
    });
  }

  async function loadStoredCaptureOptions(): Promise<CaptureOptions> {
    const value = await readPersistedValue('captureOptions');
    if (!value || typeof value !== 'object') return DEFAULT_CAPTURE_OPTIONS;
    return { ...DEFAULT_CAPTURE_OPTIONS, ...(value as Partial<CaptureOptions>) };
  }

  async function loadStoredExportOptions(): Promise<ExportOptions> {
    const value = await readPersistedValue('exportOptions');
    if (!value || typeof value !== 'object') return DEFAULT_EXPORT_OPTIONS;
    const partial = value as Partial<ExportOptions>;
    return {
      ...DEFAULT_EXPORT_OPTIONS,
      ...partial,
      jpgQuality: DEFAULT_EXPORT_OPTIONS.jpgQuality
    };
  }

  function applyCaptureOptionsToUI(options: CaptureOptions): void {
    smartScroll = options.enableSmartScroll;
  }

  function applyExportOptionsToUI(options: ExportOptions): void {
    exportFormat = options.format;
  }

  function render(status: CaptureStatus): void {
    captureStatus = status;
    progressPercent = Math.round(Math.max(0, Math.min(1, status.progress)) * 100);

    if (status.state === 'idle') {
      statusText = t('popup.status.readyToCapture');
      statusDetail = '';
      splitAlertVisible = false;
      noticeAlertVisible = false;
      errorAlertVisible = false;
      showRetryButton = false;
      showCaptureButton = true;
      setCaptureRunning(false);
      stopPolling();
      return;
    }

    if (status.state === 'running') {
      noticeAlertMessage = status.notice ?? '';
      noticeAlertVisible = Boolean(noticeAlertMessage);

      if (status.phase === 'preflight') {
        statusText = t('popup.status.analyzingPage');
        statusDetail =
          status.phaseDetail ||
          t('popup.status.progressComplete', {
            progress: Math.round((status.phaseProgress ?? 0) * 100)
          });
      } else if (status.phase === 'export') {
        statusText = t('popup.status.savingCapture');
        statusDetail = t('popup.status.downloadProgress', {
          downloaded: status.downloadedCount,
          total: status.totalCount || 1
        });
      } else {
        statusText = t('popup.status.capturingPage');
        statusDetail = t('popup.status.progressComplete', {
          progress: Math.round((status.phaseProgress ?? status.progress) * 100)
        });
        if (status.splitCount > 1) {
          splitAlertMessage = formatLargePageNotice(status.splitCount);
          splitAlertVisible = true;
        } else {
          splitAlertVisible = false;
        }
      }

      errorAlertVisible = false;
      showRetryButton = false;
      showCaptureButton = true;
      setCaptureRunning(true);
      if (pollTimer === undefined) {
        startPolling();
      }
      return;
    }

    if (status.state === 'done') {
      statusText = t('popup.status.captureComplete');
      statusDetail = formatSavedFiles(status.downloadedCount);
      splitAlertVisible = false;
      noticeAlertMessage = status.notice ?? '';
      noticeAlertVisible = Boolean(noticeAlertMessage);
      errorAlertVisible = false;
      showRetryButton = false;
      showCaptureButton = true;
      setCaptureRunning(false);
      stopPolling();
      return;
    }

    statusText = t('popup.status.captureFailed');
    statusDetail = '';
    errorAlertMessage = status.error || t('errors.unknownError');
    splitAlertVisible = false;
    noticeAlertVisible = false;
    errorAlertVisible = true;
    showCaptureButton = false;
    showRetryButton = true;
    setCaptureRunning(false);
    stopPolling();
  }

  async function sendMessage<T>(message: unknown): Promise<RuntimeResponse<T>> {
    return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
  }

  async function startCapture(): Promise<void> {
    await saveOptionsFromUI();
    setCaptureRunning(true);
    showRetryButton = false;
    errorAlertVisible = false;
    showCaptureButton = true;

    try {
      const response = await sendMessage<StartCaptureData>({ type: 'start-capture' });
      if (!response.ok || !response.data) {
        render({
          state: 'error',
          progress: 0,
          splitCount: 1,
          downloadedCount: 0,
          totalCount: 0,
          error: response.ok
            ? t('popup.errors.invalidStartStatus')
            : response.error
        });
        return;
      }
      render(response.data.status);
    } catch {
      render({
        state: 'error',
        progress: 0,
        splitCount: 1,
        downloadedCount: 0,
        totalCount: 0,
        error: t('popup.errors.couldNotStart')
      });
    }
  }

  async function startAreaCapture(): Promise<void> {
    await saveOptionsFromUI();
    setCaptureRunning(true);
    showRetryButton = false;
    errorAlertVisible = false;
    showCaptureButton = true;

    try {
      const response = await sendMessage<StartCaptureData>({ type: 'start-area-capture' });
      if (!response.ok || !response.data) {
        if (!response.ok && response.error === 'Area selection cancelled.') {
          render({ ...IDLE_STATUS });
          return;
        }
        render({
          state: 'error',
          progress: 0,
          splitCount: 1,
          downloadedCount: 0,
          totalCount: 0,
          error: response.ok ? t('popup.errors.invalidStartStatus') : response.error
        });
        return;
      }
      render(response.data.status);
    } catch {
      render({
        state: 'error',
        progress: 0,
        splitCount: 1,
        downloadedCount: 0,
        totalCount: 0,
        error: t('popup.errors.couldNotStart')
      });
    }
  }

  async function loadCurrentCaptureStatus(): Promise<void> {
    try {
      const response = await sendMessage<{ status: CaptureStatus }>({ type: 'get-capture-status' });
      if (response.ok && response.data?.status) {
        render(response.data.status);
        return;
      }
    } catch {
      stopPolling();
    }
    render({ ...IDLE_STATUS });
  }

  async function pollStatus(): Promise<void> {
    if (pollInFlight) {
      return;
    }
    pollInFlight = true;

    try {
      const response = await sendMessage<{ status: CaptureStatus }>({ type: 'get-capture-status' });
      if (response.ok && response.data?.status) {
        render(response.data.status);
        return;
      }
    } catch {
      // Treat runtime errors like status failures so polling is fully stopped.
    } finally {
      pollInFlight = false;
    }

    stopPolling();
    render({
      state: 'error',
      progress: 0,
      splitCount: 1,
      downloadedCount: 0,
      totalCount: 0,
      error: t('popup.alerts.statusUnavailable')
    });
  }

  function startPolling(): void {
    stopPolling();
    pollTimer = window.setInterval(() => {
      void pollStatus();
    }, 500);
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  async function handleAnySettingChange(): Promise<void> {
    await saveOptionsFromUI();
  }

  async function handleFormatSelect(format: ExportFormat): Promise<void> {
    exportFormat = format;
    await saveOptionsFromUI();
  }

  async function toggleSmartScrollQuick(): Promise<void> {
    smartScroll = !smartScroll;
    await saveOptionsFromUI();
  }

  async function handleResetSettings(): Promise<void> {
    if (!confirm(t('popup.modal.confirmReset'))) {
      return;
    }

    await removePersistedValues([
      'captureOptions',
      'exportOptions'
    ]);
    applyCaptureOptionsToUI(DEFAULT_CAPTURE_OPTIONS);
    applyExportOptionsToUI(DEFAULT_EXPORT_OPTIONS);
    await saveOptionsFromUI();
    closeSettings();
  }

  function handleOpenDownloads(): void {
    chrome.tabs.create({ url: 'chrome://downloads/' });
  }

  onMount(() => {
    render({ ...IDLE_STATUS });

    let disposed = false;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const mediaHandler = () => {
      if (theme === 'auto') {
        updateThemeIcon();
      }
    };
    mediaQuery.addEventListener('change', mediaHandler);

    const runtimeListener = (message: {
      type?: string;
      status?: CaptureStatus;
    }): false => {
      if (message?.type === 'capture-status' && message.status) {
        render(message.status);
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(runtimeListener);

    void (async () => {
      theme = await initTheme();
      updateThemeIcon();

      const [captureOptions, exportOptions] = await Promise.all([
        loadStoredCaptureOptions(),
        loadStoredExportOptions()
      ]);

      if (disposed) {
        return;
      }

      applyCaptureOptionsToUI(captureOptions);
      applyExportOptionsToUI(exportOptions);
      await loadCurrentCaptureStatus();

      theme = await getCurrentTheme();
      updateThemeIcon();
    })();

    return () => {
      disposed = true;
      stopPolling();
      mediaQuery.removeEventListener('change', mediaHandler);
      chrome.runtime.onMessage.removeListener(runtimeListener);
    };
  });
</script>

<svelte:window on:keydown={handleWindowKeyDown} />

<main class="container" aria-hidden={settingsOpen} inert={settingsOpen}>
  <header class="header">
    <div class="logo">
      <div class="logo-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1.5" y="5.5" width="17" height="12" rx="2" stroke="white" stroke-width="1.4" fill="rgba(255,255,255,0.15)"/>
          <circle cx="10" cy="12" r="3" stroke="white" stroke-width="1.4"/>
          <circle cx="10" cy="12" r="1.2" fill="white"/>
          <path d="M7.5 5.5V5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v.5" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
          <circle cx="16" cy="8.5" r="0.8" fill="white" fill-opacity="0.7"/>
        </svg>
      </div>
      <span class="logo-text">{t('app.title')}</span>
    </div>
    <div class="header-actions">
      <button
        class="icon-btn"
        type="button"
        title={themeToggleLabel}
        aria-label={themeToggleLabel}
        on:click={toggleTheme}
      >
        {#if effectiveTheme === 'light'}
          <!-- Sun icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>
          </svg>
        {:else}
          <!-- Moon icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
          </svg>
        {/if}
      </button>
      <button
        bind:this={settingsTriggerEl}
        class="icon-btn"
        type="button"
        title={t('popup.actions.openSettings')}
        aria-label={t('popup.actions.openSettings')}
        on:click={openSettings}
      >
        <!-- Settings gear -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    </div>
  </header>

  <section class="status-panel" aria-live="polite" aria-atomic="true">
    <p class="sr-only" role="status" aria-live="polite">{screenReaderStatus}</p>
    <div class="status-row">
      <span class="status-text">{statusText}</span>
    </div>
    {#if showProgress}
      <div
        class="progress-track"
        role="progressbar"
        aria-label={statusText}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
        aria-valuetext={t('popup.status.progressComplete', { progress: progressPercent })}
      >
        <div class="progress-bar" style={`width: ${progressPercent}%`}></div>
      </div>
    {/if}
    {#if statusDetail}
      <p class="status-detail">{statusDetail}</p>
    {/if}
    {#if splitAlertVisible}
      <div class="alert alert-warning" role="status" aria-live="polite">{splitAlertMessage}</div>
    {/if}
    {#if noticeAlertVisible}
      <div class="alert alert-warning" role="status" aria-live="polite">{noticeAlertMessage}</div>
    {/if}
    {#if errorAlertVisible}
      <div class="alert alert-error" role="alert" aria-live="assertive">{errorAlertMessage}</div>
    {/if}
  </section>

  <div class="control-strip">
    <div class="format-switch" role="group" aria-label={t('popup.quick.format')}>
      <button
        class:active={exportFormat === 'png'}
        class="format-chip"
        type="button"
        aria-pressed={exportFormat === 'png'}
        on:click={() => handleFormatSelect('png')}
      >
        {t('formats.png')}
      </button>
      <button
        class:active={exportFormat === 'jpg'}
        class="format-chip"
        type="button"
        aria-pressed={exportFormat === 'jpg'}
        on:click={() => handleFormatSelect('jpg')}
      >
        {t('formats.jpg')}
      </button>
      <button
        class:active={exportFormat === 'pdf'}
        class="format-chip"
        type="button"
        aria-pressed={exportFormat === 'pdf'}
        on:click={() => handleFormatSelect('pdf')}
      >
        {t('formats.pdf')}
      </button>
    </div>
    <button
      class:active={smartScroll}
      class="quick-toggle"
      type="button"
      aria-pressed={smartScroll}
      on:click={toggleSmartScrollQuick}
    >
      {t('popup.quick.smartScroll')}
    </button>
  </div>

  {#if showCaptureButton}
    <div class="action-row">
      <button class="capture-btn" type="button" disabled={captureRunning} on:click={startCapture}>
        {#if captureRunning}
          <svg class="spinner-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
            <path d="M22 12a10 10 0 0 0-10-10"/>
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
            <circle cx="12" cy="13" r="3"/>
          </svg>
        {/if}
        {captureButtonLabel}
      </button>
      <button class="capture-btn secondary" type="button" disabled={captureRunning} on:click={startAreaCapture}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>
        </svg>
        {t('popup.actions.captureArea')}
      </button>
    </div>
  {/if}

  {#if showRetryButton}
    <button class="capture-btn" type="button" on:click={startCapture}>
      <!-- Retry / refresh icon -->
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
        <path d="M21 3v5h-5"/>
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
        <path d="M3 21v-5h5"/>
      </svg>
      {t('popup.actions.retry')}
    </button>
  {/if}

</main>

<div class:open={settingsOpen} class="modal-overlay" aria-hidden={!settingsOpen} on:click={handleModalOverlayClick}>
  <div bind:this={modalEl} class="modal" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" on:keydown={handleModalKeyDown}>
    <div class="modal-header">
      <h2 class="modal-title" id="settings-modal-title">{t('popup.modal.title')}</h2>
      <button class="modal-close" type="button" title={t('popup.actions.closeSettings')} aria-label={t('popup.actions.closeSettings')} on:click={closeSettings}>
        <!-- Close X -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <div class="modal-body">
      <div class="modal-utility-row">
        <div class="settings-actions-grid">
          <button class="btn-sm settings-action-btn" type="button" on:click={handleResetSettings}>{t('popup.actions.resetSettings')}</button>
          <button class="btn-sm settings-action-btn" type="button" on:click={handleOpenDownloads}>{t('popup.actions.openDownloads')}</button>
        </div>
        <div class="about-row">
          <span class="app-version">{t('popup.misc.appVersion', { version: APP_VERSION })}</span>
          {#if __DEV_MODE__}
            <span class="build-badge" title={__BUILD_ID__}>dev {DEV_BUILD_LABEL}</span>
          {/if}
          <a href="https://github.com/ZnOw01/EmeraldPix" target="_blank" rel="noopener" class="github-link">GitHub</a>
        </div>
      </div>
    </div>
  </div>
</div>
