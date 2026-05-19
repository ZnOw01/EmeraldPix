<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { popupStore } from './popup-store';
  import type { ExportFormat, ThemePreference } from '../shared/messages';
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

  const APP_VERSION = __APP_VERSION__;
  const DEV_BUILD_LABEL = __BUILD_ID__.replace(/[:.]/g, '-');
  const COPY = POPUP_COPY;
  const exportFormats: ExportFormat[] = ['png', 'jpg', 'pdf'];
  const themeOptions: ThemePreference[] = ['system', 'light', 'dark'];

  $: state = $popupStore;

  // DOM refs for focus management (UI concern, stays in component)
  let settingsTriggerEl: HTMLButtonElement | null = null;
  let modalEl: HTMLDivElement | null = null;
  let previousFocusedEl: HTMLElement | null = null;

  async function openSettings(): Promise<void> {
    if (state.settingsOpen) return;
    previousFocusedEl = document.activeElement as HTMLElement | null;
    popupStore.openSettings();
    await tick();
    const firstFocusable = getModalFocusableElements()[0];
    firstFocusable?.focus();
  }

  function closeSettings(): void {
    if (!state.settingsOpen) return;
    popupStore.closeSettings();
    const restoreTarget = previousFocusedEl ?? settingsTriggerEl;
    restoreTarget?.focus();
  }

  function getModalFocusableElements(): HTMLElement[] {
    if (!modalEl) return [];
    return Array.from(
      modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
      )
    );
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

    if (event.key !== 'Tab') return;

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
    if (event.key === 'Escape' && state.settingsOpen) {
      closeSettings();
      return;
    }

    // Keyboard navigation between action buttons (ArrowUp/ArrowDown)
    const actionButtons = document.querySelectorAll<HTMLElement>(
      '.action-row button:not([disabled]), .capture-btn:not([disabled])'
    );
    if (!actionButtons.length) return;

    const activeIndex = Array.from(actionButtons).indexOf(
      document.activeElement as HTMLElement
    );
    if (activeIndex === -1) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIndex = (activeIndex + 1) % actionButtons.length;
      actionButtons[nextIndex].focus();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prevIndex =
        (activeIndex - 1 + actionButtons.length) % actionButtons.length;
      actionButtons[prevIndex].focus();
      return;
    }
  }

  function focusRadioButton(currentTarget: EventTarget | null, value: string): void {
    const group = (currentTarget as HTMLElement | null)?.parentElement;
    group?.querySelector<HTMLElement>(`[data-radio-value="${value}"]`)?.focus();
  }

  async function handleFormatRadioKeyDown(
    event: KeyboardEvent,
    current: ExportFormat
  ): Promise<void> {
    const next = popupStore.getRadioSelection(exportFormats, current, event.key);
    if (!next) return;
    event.preventDefault();
    await popupStore.handleFormatSelect(next);
    focusRadioButton(event.currentTarget, next);
  }

  async function handleThemeRadioKeyDown(
    event: KeyboardEvent,
    current: ThemePreference
  ): Promise<void> {
    const next = popupStore.getRadioSelection(themeOptions, current, event.key);
    if (!next) return;
    event.preventDefault();
    await popupStore.applyThemeSelection(next);
    focusRadioButton(event.currentTarget, next);
  }

  onMount(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;

    void (async () => {
      dispose = await popupStore.initialize();
      if (disposed && dispose) {
        dispose();
      }
    })();

    return () => {
      disposed = true;
      if (dispose) dispose();
      else popupStore.dispose();
    };
  });
</script>

<svelte:window on:keydown={handleWindowKeyDown} />

<main class="container" aria-hidden={state.settingsOpen} inert={state.settingsOpen} in:fade={{ duration: 400 }}>
  <header class="header">
    <div class="logo">
      <div class="logo-icon" aria-hidden="true">
        <LogoIcon />
      </div>
      <span class="logo-text">{COPY['app.title']}</span>
    </div>
    <div class="header-actions">
      <button
        class="icon-btn"
        type="button"
        title={state.themeToggleLabel}
        aria-label={state.themeToggleLabel}
        on:click={() => void popupStore.toggleTheme()}
      >
        {#if state.effectiveTheme === 'light'}
          <SunIcon />
        {:else}
          <MoonIcon />
        {/if}
      </button>
      <button
        bind:this={settingsTriggerEl}
        class="icon-btn"
        type="button"
        title={COPY['popup.actions.openSettings']}
        aria-label={COPY['popup.actions.openSettings']}
        on:click={openSettings}
      >
        <SettingsIcon />
      </button>
    </div>
  </header>

  <section class="status-panel" in:fly={{ y: 10, duration: 400, delay: 100 }}>
    <p class="sr-only" role="status" aria-live="polite">{state.screenReaderStatus}</p>
    <div class="status-row">
      <span class="status-text">{state.statusText}</span>
    </div>
    {#if state.showProgress}
      <div
        class="progress-track"
        role="progressbar"
        aria-label={state.statusText}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.progressPercent}
        aria-valuetext={COPY['popup.status.progressComplete']?.replace('{progress}', String(state.progressPercent)) ?? `${state.progressPercent}%`}
      >
        <div class="progress-bar" style:width={`${state.progressPercent}%`}></div>
      </div>
    {/if}
    {#if state.statusDetail}
      <p class="status-detail">{state.statusDetail}</p>
    {/if}
    {#if state.splitAlertVisible}
      <div class="alert alert-warning" role="status" aria-live="polite">{state.splitAlertMessage}</div>
    {/if}
    {#if state.noticeAlertVisible}
      <div class="alert alert-warning" role="status" aria-live="polite">{state.noticeAlertMessage}</div>
    {/if}
    {#if state.errorAlertVisible}
      <div class="alert alert-error" role="alert" aria-live="assertive">{state.errorAlertMessage}</div>
    {/if}
  </section>

  <div class="control-strip" role="radiogroup" aria-label={COPY['popup.quick.format']} in:fly={{ y: 10, duration: 400, delay: 200 }}>
    <button
      data-radio-value="png"
      class:active={state.exportFormat === 'png'}
      class="format-chip"
      type="button"
      role="radio"
      aria-checked={state.exportFormat === 'png'}
      tabindex={state.exportFormat === 'png' ? 0 : -1}
      on:click={() => void popupStore.handleFormatSelect('png')}
      on:keydown={(event) => void handleFormatRadioKeyDown(event, 'png')}
    >
      {COPY['formats.png']}
    </button>
    <button
      data-radio-value="jpg"
      class:active={state.exportFormat === 'jpg'}
      class="format-chip"
      type="button"
      role="radio"
      aria-checked={state.exportFormat === 'jpg'}
      tabindex={state.exportFormat === 'jpg' ? 0 : -1}
      on:click={() => void popupStore.handleFormatSelect('jpg')}
      on:keydown={(event) => void handleFormatRadioKeyDown(event, 'jpg')}
    >
      {COPY['formats.jpg']}
    </button>
    <button
      data-radio-value="pdf"
      class:active={state.exportFormat === 'pdf'}
      class="format-chip"
      type="button"
      role="radio"
      aria-checked={state.exportFormat === 'pdf'}
      tabindex={state.exportFormat === 'pdf' ? 0 : -1}
      on:click={() => void popupStore.handleFormatSelect('pdf')}
      on:keydown={(event) => void handleFormatRadioKeyDown(event, 'pdf')}
    >
      {COPY['formats.pdf']}
    </button>
  </div>

  {#if !state.canCapture}
    <div class="alert alert-warning" role="status" aria-live="polite" in:fade>{state.uncapturableReason}</div>
  {/if}

  {#if state.showCaptureButton && state.canCapture}
    <div class="action-row" in:fly={{ y: 15, duration: 500, delay: 300 }}>
      <button class="capture-btn" type="button" disabled={state.captureRunning} on:click={() => void popupStore.startCapture()}>
        {#if state.captureRunning}
          <SpinnerIcon />
        {:else}
          <CameraIcon />
        {/if}
        {state.captureButtonLabel}
      </button>
      <button class="capture-btn secondary" type="button" disabled={state.captureRunning} on:click={() => void popupStore.startAreaCapture()}>
        <AreaIcon />
        {COPY['popup.actions.captureArea']}
      </button>
    </div>
  {/if}

  {#if state.showRetryButton && state.canCapture}
    <button class="capture-btn" type="button" on:click={() => void popupStore.retryCapture()} in:scale={{ duration: 300 }}>
      <RetryIcon />
      {COPY['popup.actions.retry']}
    </button>
  {/if}
</main>

{#if state.settingsOpen}
<div
  class="modal-overlay"
  role="presentation"
  transition:fade={{ duration: 160 }}
  on:mousedown={handleModalOverlayMouseDown}
>
  <div bind:this={modalEl} class="modal" transition:fly={{ y: 10, duration: 180 }} tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" on:keydown={handleModalKeyDown}>
    <div class="modal-header">
      <h2 class="modal-title" id="settings-modal-title">{COPY['popup.modal.title']}</h2>
      <button class="modal-close" type="button" title={COPY['popup.actions.closeSettings']} aria-label={COPY['popup.actions.closeSettings']} on:click={closeSettings}>
        <CloseIcon />
      </button>
    </div>

    <div class="modal-body">
      <div class="settings-stack">
        <section class="settings-section">
          <div class="section-copy">
            <p class="section-eyebrow">{COPY['popup.settings.appearance']}</p>
            <p class="settings-help">{COPY['popup.modal.themeHelp']}</p>
          </div>

          <div class="theme-switch" role="radiogroup" aria-label={COPY['popup.settings.appearance']}>
            <button
              data-radio-value="system"
              class:active={state.themePreference === 'system'}
              class="theme-chip"
              type="button"
              role="radio"
              aria-checked={state.themePreference === 'system'}
              tabindex={state.themePreference === 'system' ? 0 : -1}
              on:click={() => void popupStore.applyThemeSelection('system')}
              on:keydown={(event) => void handleThemeRadioKeyDown(event, 'system')}
            >
              {COPY['popup.modal.themeSystem']}
            </button>
            <button
              data-radio-value="light"
              class:active={state.themePreference === 'light'}
              class="theme-chip"
              type="button"
              role="radio"
              aria-checked={state.themePreference === 'light'}
              tabindex={state.themePreference === 'light' ? 0 : -1}
              on:click={() => void popupStore.applyThemeSelection('light')}
              on:keydown={(event) => void handleThemeRadioKeyDown(event, 'light')}
            >
              {COPY['popup.modal.themeLight']}
            </button>
            <button
              data-radio-value="dark"
              class:active={state.themePreference === 'dark'}
              class="theme-chip"
              type="button"
              role="radio"
              aria-checked={state.themePreference === 'dark'}
              tabindex={state.themePreference === 'dark' ? 0 : -1}
              on:click={() => void popupStore.applyThemeSelection('dark')}
              on:keydown={(event) => void handleThemeRadioKeyDown(event, 'dark')}
            >
              {COPY['popup.modal.themeDark']}
            </button>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-copy">
            <p class="section-eyebrow">{COPY['popup.settings.saving']}</p>
          </div>

          <div class="setting-stack">
            <div class="settings-inline-row">
              <span class="settings-label">{COPY['popup.settings.askWhereToSave']}</span>
              <button
                class:active={state.askWhereToSave}
                class="quick-toggle compact"
                type="button"
                aria-pressed={state.askWhereToSave}
                on:click={() => void popupStore.toggleAskWhereToSave()}
              >
                {state.askWhereToSave ? COPY['popup.modal.enabled'] : COPY['popup.modal.disabled']}
              </button>
            </div>
            <p class="settings-help">{COPY['popup.settings.askWhereToSaveHelp']}</p>
          </div>
          {#if state.exportFormat === 'jpg'}
            <div class="setting-stack">
              <div class="settings-inline-row">
                <span class="settings-label">{COPY['popup.settings.jpgQuality']}</span>
                <span class="settings-metric">{state.jpgQualityPercent}%</span>
              </div>
              <input
                type="range"
                min="0.4"
                max="1"
                step="0.05"
                value={state.jpgQuality}
                on:input={(event) => popupStore.setJpgQuality(parseFloat(event.currentTarget.value))}
              />
              <p class="settings-help">{COPY['popup.settings.jpgQualityHelp']}</p>
            </div>
          {/if}
        </section>

        <section class="settings-section">
          <div class="section-copy">
            <p class="section-eyebrow">{COPY['popup.settings.capture']}</p>
          </div>

          <div class="setting-stack">
            <div class="settings-inline-row">
              <span class="settings-label">{COPY['popup.settings.smoothStitching']}</span>
              <button
                class:active={state.smartScroll}
                class="quick-toggle compact"
                type="button"
                aria-pressed={state.smartScroll}
                on:click={() => void popupStore.toggleSmoothStitching()}
              >
                {state.smartScroll ? COPY['popup.modal.enabled'] : COPY['popup.modal.disabled']}
              </button>
            </div>
            <p class="settings-help">{COPY['popup.settings.smoothStitchingHelp']}</p>
          </div>
        </section>

        <div class="modal-utility-row">
          <div class="settings-actions-grid">
            <button class="btn-sm settings-action-btn" type="button" on:click={() => void popupStore.handleResetSettings()}>{COPY['popup.actions.resetSettings']}</button>
            <button class="btn-sm settings-action-btn" type="button" on:click={() => popupStore.handleOpenDownloads()}>{COPY['popup.actions.openDownloads']}</button>
          </div>
          <div class="about-row">
            <span class="app-version">{COPY['popup.misc.appVersion']?.replace('{version}', APP_VERSION) ?? `v${APP_VERSION}`}</span>
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
