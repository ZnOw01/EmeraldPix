import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixtureServer } from './test-server';

type RuntimeResponse<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
type ActiveTabInfo = { id?: number; url?: string };

interface ExtensionHarness {
  context: BrowserContext;
  harnessPage: Page;
  extensionId: string;
  downloadsDir: string;
  userDataDir: string;
}

const extensionPath = resolve(process.cwd(), 'dist');
const requestedBrowserChannel = process.env.E2E_CHROMIUM_CHANNEL?.trim();
const browserChannel =
  requestedBrowserChannel?.toLowerCase() === 'bundled'
    ? undefined
    : requestedBrowserChannel || (process.env.CI ? undefined : 'chrome');

const e2eHeadless = process.env.E2E_HEADLESS === 'true' || process.env.CI === 'true';

async function launchHarness(): Promise<ExtensionHarness> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'screencap-pw-'));
  const downloadsDir = join(userDataDir, 'downloads');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: e2eHeadless,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    channel: browserChannel,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  const extensionId = serviceWorker.url().split('/')[2];

  const harnessPage = await context.newPage();
  await harnessPage.goto(`chrome-extension://${extensionId}/test-harness.html`);

  return {
    context,
    harnessPage,
    extensionId,
    downloadsDir,
    userDataDir
  };
}

async function closeHarness(harness: ExtensionHarness): Promise<void> {
  await harness.context.close();
  await rm(harness.userDataDir, { recursive: true, force: true });
}

async function sendMessage<T>(
  harnessPage: Page,
  message: unknown,
  timeoutMs = 15_000
): Promise<RuntimeResponse<T>> {
  const request = harnessPage.evaluate(async (payload) => {
    return chrome.runtime.sendMessage(payload);
  }, message) as Promise<RuntimeResponse<T>>;

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for runtime message response.'));
    }, timeoutMs);
    void request.finally(() => clearTimeout(timer));
  });

  return Promise.race([request, timeout]);
}

async function getActiveTab(harnessPage: Page): Promise<ActiveTabInfo> {
  return harnessPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    return { id: tab?.id, url: tab?.url };
  });
}

async function waitForActiveTabUrl(
  harnessPage: Page,
  expectedPrefix: string,
  timeoutMs = 15_000
): Promise<ActiveTabInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await getActiveTab(harnessPage);
    if (active.url?.startsWith(expectedPrefix)) {
      return active;
    }
    await harnessPage.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for active tab URL prefix: ${expectedPrefix}`);
}

async function activateTabByUrlPrefix(
  harnessPage: Page,
  expectedPrefix: string,
  timeoutMs = 15_000
): Promise<ActiveTabInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await harnessPage.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((tab) => typeof tab.id === 'number' && tab.url?.startsWith(prefix));
      if (target && typeof target.id === 'number') {
        await chrome.tabs.update(target.id, { active: true });
      }
    }, expectedPrefix);

    const active = await getActiveTab(harnessPage);
    if (active.url?.startsWith(expectedPrefix)) {
      return active;
    }
    await harnessPage.waitForTimeout(250);
  }
  throw new Error(`Timed out activating tab URL prefix: ${expectedPrefix}`);
}

type CaptureStatusSnapshot = {
  state: string;
  downloadedCount?: number;
  totalCount?: number;
};

async function waitForCaptureState(
  harnessPage: Page,
  timeoutMs = 60_000
): Promise<CaptureStatusSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendMessage<{ status: CaptureStatusSnapshot }>(
        harnessPage,
        { type: 'get-capture-status' },
        5_000
      );
      if (response.ok && response.data?.status?.state) {
        if (response.data.status.state === 'done') {
          return response.data.status;
        }
        if (response.data.status.state === 'error') {
          return response.data.status;
        }
      }
    } catch {
      // Keep polling; runtime messages can transiently fail while worker wakes up.
    }
    await harnessPage.waitForTimeout(300);
  }
  throw new Error('Timed out waiting for capture status.');
}

async function waitForDownloadedFile(
  downloadsDir: string,
  timeoutMs = 20_000
): Promise<{ filename: string; size: number }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readdir(downloadsDir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith('.crdownload') && !name.endsWith('.tmp'));

    for (const filename of files) {
      const fileStat = await stat(join(downloadsDir, filename));
      if (fileStat.size > 0) {
        return { filename, size: fileStat.size };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error('Timed out waiting for downloaded artifact.');
}

async function runCaptureAndAssertDownload(
  harness: ExtensionHarness,
  fixtureUrl: string
): Promise<{ filename: string; size: number }> {
  const page = await harness.context.newPage();
  try {
    await page.goto(fixtureUrl);
    await page.bringToFront();

    const activeTab = await activateTabByUrlPrefix(harness.harnessPage, fixtureUrl);
    expect(activeTab.id).toBeDefined();

    const start = await sendMessage(harness.harnessPage, { type: 'start-capture' });
    expect(start.ok).toBe(true);

    const status = await waitForCaptureState(harness.harnessPage);
    expect(status.state).toBe('done');
    expect(status.downloadedCount ?? 0).toBeGreaterThan(0);
    expect(status.totalCount ?? 0).toBeGreaterThan(0);

    return await waitForDownloadedFile(harness.downloadsDir);
  } finally {
    await page.close().catch(() => undefined);
  }
}

test.describe('ScreenCap extension e2e', () => {
  test.describe.configure({ timeout: 180_000 });

  test('loads popup UI after Svelte migration', async () => {
    const harness = await launchHarness();
    try {
      const popupPage = await harness.context.newPage();
      await popupPage.goto(`chrome-extension://${harness.extensionId}/popup.html`);
      await expect(popupPage.getByText('ScreenCap', { exact: true })).toHaveCount(1);
      await expect(popupPage.getByRole('button', { name: /capture full page/i })).toHaveCount(1);
    } finally {
      await closeHarness(harness);
    }
  });

  test('captures long page and downloads PNG', async () => {
    const fixture = await startFixtureServer();
    const harness = await launchHarness();
    try {
      const fixtureUrl = `${fixture.origin}/long.html`;
      const downloaded = await runCaptureAndAssertDownload(harness, fixtureUrl);
      expect(downloaded.filename.toLowerCase()).toContain('screenshot_');
      expect(downloaded.filename.toLowerCase().endsWith('.png')).toBeTruthy();
      expect(downloaded.size).toBeGreaterThan(0);
    } finally {
      await closeHarness(harness);
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  test('captures infinite-scroll style page without error', async () => {
    const fixture = await startFixtureServer();
    const harness = await launchHarness();
    try {
      const fixtureUrl = `${fixture.origin}/infinite.html`;
      const downloaded = await runCaptureAndAssertDownload(harness, fixtureUrl);
      expect(downloaded.filename.toLowerCase().endsWith('.png')).toBeTruthy();
      expect(downloaded.size).toBeGreaterThan(0);
    } finally {
      await closeHarness(harness);
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  test('fails gracefully on blocked chrome:// URL', async () => {
    const harness = await launchHarness();
    try {
      await harness.harnessPage.bringToFront();
      await waitForActiveTabUrl(harness.harnessPage, 'chrome-extension://');

      const start = await sendMessage(harness.harnessPage, { type: 'start-capture' });
      expect(start.ok).toBe(false);
      if (!start.ok) {
        expect(start.error.toLowerCase()).toContain('cannot be captured');
      }
    } finally {
      await closeHarness(harness);
    }
  });
});
