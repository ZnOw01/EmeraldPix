<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import type { CaptureStatus, ExportFormat, RuntimeResponse } from '../shared/messages';
  import {
    readPersistedValue,
    removePersistedValues,
    writePersistedValues
  } from '../shared/persisted-store';
  import { formatMessage } from '../shared/format-message';
  import { AREA_SELECTION_CANCELLED } from '../shared/utils';
  import {
    applyTheme,
    getThemePreference,
    initTheme,
    resetThemePreference,
    setThemePreference,
    type Theme,
    type ThemePreference
  } from '../shared/theme';
  import {
    composePersistedPopupSettings,
    createDefaultPopupSettingsState,
    createPopupSettingsState,
    type PopupSettingsState
  } from './settings-model';
  import { POPUP_COPY } from './copy';
  import AreaIcon from './icons/AreaIcon.svelte';
  import CameraIcon from './icons/CameraIcon.svelte';
  import CloseIcon from './icons/CloseIcon.svelte';
  import LogoIcon from './icons/LogoIcon.svelte';
  import MoonIcon from './icons/MoonIcon.svelte';
  import RetryIcon from './icons/RetryIcon.svelte';
  import SettingsIcon from './icons/SettingsIcon.svelte';
  import SpinnerIcon from './icons/SpinnerIcon.svelte';
  import SunIcon from './icons/SunIcon.svelte';

  interface StartCaptureData {
    status: CaptureStatus;
    alreadyRunning: boolean;
  }

  const APP_VERSION = __APP_VERSION__;
  const DEV_BUILD_LABEL = __BUILD_ID__.replace(/[:.]/g, '-');
  const COPY = POPUP_COPY;
  const exportFormats: ExportFormat[] = ['png', 'jpg', 'pdf'];
  const themeOptions: ThemePreference[] = ['system', 'light', 'dark'];

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
  let statusText = COPY['popup.status.readyToCapture'];
  let statusDetail = '';

  let splitAlertVisible = false;
  let splitAlertMessage = '';
  let noticeAlertVisible = false;
  let noticeAlertMessage = '';
  let errorAlertVisible = false;
  let errorAlertMessage = '';

  let lastCaptureType: 'full' | 'area' = 'full';

  const defaults = createDefaultPopupSettingsState();
  let smartScroll = defaults.smoothStitching;
  let exportFormat: ExportFormat = defaults.exportFormat;
  let jpgQuality = defaults.jpgQuality;
  let askWhereToSave = defaults.askWhereToSave;

  let settingsOpen = false;
  let effectiveTheme: Theme = 'light';
  let themePreference: ThemePreference = 'system';

  let settingsTriggerEl: HTMLButtonElement | null = null;
  let modalEl: HTMLDivElement | null = null;
  let previousFocusedEl: HTMLElement | null = null;

  $: isIdle = captureStatus.state === 'idle';
  $: isRunning = captureStatus.state === 'running';
  $: isDone = captureStatus.state === 'done';
  $: isError = captureStatus.state === 'error';
  $: captureRunning = isRunning;
  $: showProgress = isRunning || isDone;
  $: showCaptureButton = !isError;
  $: showRetryButton = isError;
  $: progressPercent = Math.round(Math.max(0, Math.min(1, captureStatus.progress)) * 100);
  $: captureButtonLabel = captureRunning
    ? t('popup.actions.capturing')
    : t('popup.actions.capture');
  $: themeToggleLabel =
    effectiveTheme === 'light'
      ? t('popup.actions.toggleThemeDark')
      : t('popup.actions.toggleThemeLight');
  $: jpgQualityPercent = Math.round(jpgQuality * 100);

  $: {
    if (isIdle) {
      statusText = t('popup.status.readyToCapture');
      statusDetail = '';
      splitAlertMessage = '';
      splitAlertVisible = false;
      noticeAlertMessage = '';
      noticeAlertVisible = false;
      errorAlertMessage = '';
      errorAlertVisible = false;
    } else if (isRunning) {
      noticeAlertMessage = captureStatus.notice ?? '';
      noticeAlertVisible = Boolean(noticeAlertMessage);
      errorAlertMessage = '';
      errorAlertVisible = false;

      if (captureStatus.phase === 'preflight') {
        statusText = t('popup.status.analyzingPage');
        statusDetail =
          captureStatus.phaseDetail ||
          t('popup.status.progressComplete', {
            progress: Math.round((captureStatus.phaseProgress ?? 0) * 100)
          });
      } else if (captureStatus.phase === 'export') {
        statusText = t('popup.status.savingCapture');
        statusDetail = t('popup.status.downloadProgress', {
          downloaded: captureStatus.downloadedCount,
          total: captureStatus.totalCount || 1
        });
      } else {
        statusText = t('popup.status.capturingPage');
        statusDetail = t('popup.status.progressComplete', {
          progress: Math.round((captureStatus.phaseProgress ?? captureStatus.progress) * 100)
        });
      }

      splitAlertMessage =
        captureStatus.phase === 'capture' && captureStatus.splitCount > 1
          ? formatLargePageNotice(captureStatus.splitCount)
          : '';
      splitAlertVisible = Boolean(splitAlertMessage);
    } else if (isDone) {
      statusText = t('popup.status.captureComplete');
      statusDetail = formatSavedFiles(captureStatus.downloadedCount);
      splitAlertMessage = '';
      splitAlertVisible = false;
      noticeAlertMessage = captureStatus.notice ?? '';
      noticeAlertVisible = Boolean(noticeAlertMessage);
      errorAlertMessage = '';
      errorAlertVisible = false;
    } else {
      statusText = t('popup.status.captureFailed');
      statusDetail = '';
      splitAlertMessage = '';
      splitAlertVisible = false;
      noticeAlertMessage = '';
      noticeAlertVisible = false;
      errorAlertMessage = captureStatus.error || t('errors.unknownError');
      errorAlertVisible = true;
    }
  }

  $: screenReaderStatus = statusDetail ? `${statusText}. ${statusDetail}` : statusText;
  $: if (isRunning) {
    if (pollTimer === undefined) {
      startPolling();
    }
  } else {
    stopPolling();
  }

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

  async function toggleTheme(): Promise<void> {
    const nextTheme: Theme = effectiveTheme === 'dark' ? 'light' : 'dark';
    themePreference = nextTheme;
    await setThemePreference(nextTheme);
    effectiveTheme = nextTheme;
  }

  async function applyThemeSelection(nextPreference: ThemePreference): Promise<void> {
    themePreference = nextPreference;

    if (nextPreference === 'system') {
      effectiveTheme = await resetThemePreference();
    } else {
      await setThemePreference(nextPreference);
      effectiveTheme = nextPreference;
    }
  }

  function getModalFocusableElements(): HTMLElement[] {
    if (!modalEl) {
      return [];
    }

    return Array.from(
      modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
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

  function handleModalOverlayMouseDown(event: MouseEvent): void {
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

  function currentPopupSettingsState(): PopupSettingsState {
    return {
      askWhereToSave,
      exportFormat,
      jpgQuality,
      smoothStitching: smartScroll
    };
  }

  async function saveOptionsFromUI(): Promise<void> {
    const persisted = composePersistedPopupSettings(currentPopupSettingsState());
    await writePersistedValues(persisted);
  }

  async function loadStoredPopupSettings(): Promise<PopupSettingsState> {
    const [captureOptions, exportOptions, downloadOptions] = await Promise.all([
      readPersistedValue('captureOptions'),
      readPersistedValue('exportOptions'),
      readPersistedValue('downloadOptions')
    ]);

    return createPopupSettingsState({
      captureOptions,
      exportOptions,
      downloadOptions
    });
  }

  function applyPopupSettingsToUI(settings: PopupSettingsState): void {
    smartScroll = settings.smoothStitching;
    exportFormat = settings.exportFormat;
    jpgQuality = settings.jpgQuality;
    askWhereToSave = settings.askWhereToSave;
  }

  function render(status: CaptureStatus): void {
    captureStatus = status;
  }

  async function sendMessage<T>(message: unknown): Promise<RuntimeResponse<T>> {
    return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
  }

  async function executeCapture(
    captureType: 'full' | 'area',
    messageType: 'start-capture' | 'start-area-capture'
  ): Promise<void> {
    lastCaptureType = captureType;
    render({
      ...IDLE_STATUS,
      state: 'running',
      phase: 'preflight',
      phaseProgress: 0
    });
    await saveOptionsFromUI();

    try {
      const response = await sendMessage<StartCaptureData>({ type: messageType });
      if (!response.ok || !response.data) {
        if (!response.ok && response.error === AREA_SELECTION_CANCELLED) {
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

  async function startCapture(): Promise<void> {
    return executeCapture('full', 'start-capture');
  }

  async function startAreaCapture(): Promise<void> {
    return executeCapture('area', 'start-area-capture');
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

  async function handleFormatSelect(format: ExportFormat): Promise<void> {
    exportFormat = format;
    await saveOptionsFromUI();
  }

  function getRadioSelection<T extends string>(
    options: readonly T[],
    current: T,
    key: string
  ): T | null {
    const index = options.indexOf(current);
    if (index === -1) {
      return null;
    }

    if (key === 'ArrowRight' || key === 'ArrowDown') {
      return options[(index + 1) % options.length];
    }

    if (key === 'ArrowLeft' || key === 'ArrowUp') {
      return options[(index - 1 + options.length) % options.length];
    }

    if (key === 'Home') {
      return options[0];
    }

    if (key === 'End') {
      return options[options.length - 1];
    }

    return null;
  }

  function focusRadioButton(currentTarget: EventTarget | null, value: string): void {
    const group = (currentTarget as HTMLElement | null)?.parentElement;
    group?.querySelector<HTMLElement>(`[data-radio-value="${value}"]`)?.focus();
  }

  async function handleFormatRadioKeyDown(
    event: KeyboardEvent,
    current: ExportFormat
  ): Promise<void> {
    const next = getRadioSelection(exportFormats, current, event.key);
    if (!next) {
      return;
    }

    event.preventDefault();
    await handleFormatSelect(next);
    focusRadioButton(event.currentTarget, next);
  }

  async function handleThemeRadioKeyDown(
    event: KeyboardEvent,
    current: ThemePreference
  ): Promise<void> {
    const next = getRadioSelection(themeOptions, current, event.key);
    if (!next) {
      return;
    }

    event.preventDefault();
    await applyThemeSelection(next);
    focusRadioButton(event.currentTarget, next);
  }

  async function toggleAskWhereToSave(): Promise<void> {
    askWhereToSave = !askWhereToSave;
    await saveOptionsFromUI();
  }

  async function toggleSmoothStitching(): Promise<void> {
    smartScroll = !smartScroll;
    await saveOptionsFromUI();
  }

  async function handleResetSettings(): Promise<void> {
    if (!confirm(t('popup.modal.confirmReset'))) {
      return;
    }

    await removePersistedValues(['captureOptions', 'exportOptions', 'downloadOptions']);
    applyPopupSettingsToUI(createDefaultPopupSettingsState());
    await saveOptionsFromUI();

    themePreference = 'system';
    effectiveTheme = await resetThemePreference();
    closeSettings();
  }

  function getDownloadsPageUrl(): string {
    const userAgent = navigator.userAgent;
    if (userAgent.includes('Edg/')) {
      return 'edge://downloads/';
    }
    return 'chrome://downloads/';
  }

  function handleOpenDownloads(): void {
    chrome.tabs.create({ url: getDownloadsPageUrl() });
  }

  onMount(() => {
    render({ ...IDLE_STATUS });

    let disposed = false;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const runtimeListener = (message: {
      type?: string;
      status?: CaptureStatus;
    }): false => {
      if (message?.type === 'capture-status' && message.status) {
        render(message.status);
      }
      return false;
    };

    const handleSystemThemeChange = (event: MediaQueryListEvent): void => {
      if (themePreference !== 'system') {
        return;
      }

      effectiveTheme = event.matches ? 'dark' : 'light';
      void applyTheme(effectiveTheme);
    };

    chrome.runtime.onMessage.addListener(runtimeListener);
    mediaQuery.addEventListener('change', handleSystemThemeChange);

    void (async () => {
      const pref = await getThemePreference();
      if (disposed) return;
      themePreference = pref;

      const resolvedTheme = await initTheme();
      if (disposed) return;
      effectiveTheme = resolvedTheme;

      const settings = await loadStoredPopupSettings();
      if (disposed) return;

      applyPopupSettingsToUI(settings);
      await loadCurrentCaptureStatus();
    })();

    return () => {
      disposed = true;
      stopPolling();
      chrome.runtime.onMessage.removeListener(runtimeListener);
      mediaQuery.removeEventListener('change', handleSystemThemeChange);
    };
  });
</script>

<svelte:window on:keydown={handleWindowKeyDown} />

<main class="container" aria-hidden={settingsOpen} inert={settingsOpen}>
  <header class="header">
    <div class="logo">
      <div class="logo-icon" aria-hidden="true">
        <LogoIcon />
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
          <SunIcon />
        {:else}
          <MoonIcon />
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
        <SettingsIcon />
      </button>
    </div>
  </header>

  <section class="status-panel">
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
        <div class="progress-bar" style:width={`${progressPercent}%`}></div>
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

  <div class="control-strip" role="radiogroup" aria-label={t('popup.quick.format')}>
    <button
      data-radio-value="png"
      class:active={exportFormat === 'png'}
      class="format-chip"
      type="button"
      role="radio"
      aria-checked={exportFormat === 'png'}
      tabindex={exportFormat === 'png' ? 0 : -1}
      on:click={() => handleFormatSelect('png')}
      on:keydown={(event) => void handleFormatRadioKeyDown(event, 'png')}
    >
      {t('formats.png')}
    </button>
    <button
      data-radio-value="jpg"
      class:active={exportFormat === 'jpg'}
      class="format-chip"
      type="button"
      role="radio"
      aria-checked={exportFormat === 'jpg'}
      tabindex={exportFormat === 'jpg' ? 0 : -1}
      on:click={() => handleFormatSelect('jpg')}
      on:keydown={(event) => void handleFormatRadioKeyDown(event, 'jpg')}
    >
      {t('formats.jpg')}
    </button>
    <button
      data-radio-value="pdf"
      class:active={exportFormat === 'pdf'}
      class="format-chip"
      type="button"
      role="radio"
      aria-checked={exportFormat === 'pdf'}
      tabindex={exportFormat === 'pdf' ? 0 : -1}
      on:click={() => handleFormatSelect('pdf')}
      on:keydown={(event) => void handleFormatRadioKeyDown(event, 'pdf')}
    >
      {t('formats.pdf')}
    </button>
  </div>

  {#if showCaptureButton}
    <div class="action-row">
      <button class="capture-btn" type="button" disabled={captureRunning} on:click={startCapture}>
        {#if captureRunning}
          <SpinnerIcon />
        {:else}
          <CameraIcon />
        {/if}
        {captureButtonLabel}
      </button>
      <button class="capture-btn secondary" type="button" disabled={captureRunning} on:click={startAreaCapture}>
        <AreaIcon />
        {t('popup.actions.captureArea')}
      </button>
    </div>
  {/if}

  {#if showRetryButton}
    <button class="capture-btn" type="button" on:click={lastCaptureType === 'area' ? startAreaCapture : startCapture}>
      <RetryIcon />
      {t('popup.actions.retry')}
    </button>
  {/if}
</main>

{#if settingsOpen}
<div
  class="modal-overlay"
  role="presentation"
  transition:fade={{ duration: 160 }}
  on:mousedown={handleModalOverlayMouseDown}
>
  <div bind:this={modalEl} class="modal" transition:fly={{ y: 10, duration: 180 }} tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" on:keydown={handleModalKeyDown}>
    <div class="modal-header">
      <h2 class="modal-title" id="settings-modal-title">{t('popup.modal.title')}</h2>
      <button class="modal-close" type="button" title={t('popup.actions.closeSettings')} aria-label={t('popup.actions.closeSettings')} on:click={closeSettings}>
        <CloseIcon />
      </button>
    </div>

    <div class="modal-body">
      <div class="settings-stack">
        <section class="settings-section">
          <div class="section-copy">
            <p class="section-eyebrow">{t('popup.settings.appearance')}</p>
            <p class="settings-help">{t('popup.modal.themeHelp')}</p>
          </div>

          <div class="theme-switch" role="radiogroup" aria-label={t('popup.settings.appearance')}>
            <button
              data-radio-value="system"
              class:active={themePreference === 'system'}
              class="theme-chip"
              type="button"
              role="radio"
              aria-checked={themePreference === 'system'}
              tabindex={themePreference === 'system' ? 0 : -1}
              on:click={() => void applyThemeSelection('system')}
              on:keydown={(event) => void handleThemeRadioKeyDown(event, 'system')}
            >
              {t('popup.modal.themeSystem')}
            </button>
            <button
              data-radio-value="light"
              class:active={themePreference === 'light'}
              class="theme-chip"
              type="button"
              role="radio"
              aria-checked={themePreference === 'light'}
              tabindex={themePreference === 'light' ? 0 : -1}
              on:click={() => void applyThemeSelection('light')}
              on:keydown={(event) => void handleThemeRadioKeyDown(event, 'light')}
            >
              {t('popup.modal.themeLight')}
            </button>
            <button
              data-radio-value="dark"
              class:active={themePreference === 'dark'}
              class="theme-chip"
              type="button"
              role="radio"
              aria-checked={themePreference === 'dark'}
              tabindex={themePreference === 'dark' ? 0 : -1}
              on:click={() => void applyThemeSelection('dark')}
              on:keydown={(event) => void handleThemeRadioKeyDown(event, 'dark')}
            >
              {t('popup.modal.themeDark')}
            </button>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-copy">
            <p class="section-eyebrow">{t('popup.settings.saving')}</p>
          </div>

          <div class="setting-stack">
            <div class="settings-inline-row">
              <span class="settings-label">{t('popup.settings.askWhereToSave')}</span>
              <button
                class:active={askWhereToSave}
                class="quick-toggle compact"
                type="button"
                aria-pressed={askWhereToSave}
                on:click={toggleAskWhereToSave}
              >
                {askWhereToSave ? t('popup.modal.enabled') : t('popup.modal.disabled')}
              </button>
            </div>
            <p class="settings-help">{t('popup.settings.askWhereToSaveHelp')}</p>
          </div>

          {#if exportFormat === 'jpg'}
            <div class="setting-stack">
              <div class="settings-inline-row">
                <span class="settings-label">{t('popup.settings.jpgQuality')}</span>
                <span class="settings-metric">{jpgQualityPercent}%</span>
              </div>
              <input
                type="range"
                min="0.4"
                max="1"
                step="0.05"
                bind:value={jpgQuality}
                on:change={() => void saveOptionsFromUI()}
              />
              <p class="settings-help">{t('popup.settings.jpgQualityHelp')}</p>
            </div>
          {/if}
        </section>

        <section class="settings-section">
          <div class="section-copy">
            <p class="section-eyebrow">{t('popup.settings.capture')}</p>
          </div>

          <div class="setting-stack">
            <div class="settings-inline-row">
              <span class="settings-label">{t('popup.settings.smoothStitching')}</span>
              <button
                class:active={smartScroll}
                class="quick-toggle compact"
                type="button"
                aria-pressed={smartScroll}
                on:click={toggleSmoothStitching}
              >
                {smartScroll ? t('popup.modal.enabled') : t('popup.modal.disabled')}
              </button>
            </div>
            <p class="settings-help">{t('popup.settings.smoothStitchingHelp')}</p>
          </div>
        </section>

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
</div>
{/if}
