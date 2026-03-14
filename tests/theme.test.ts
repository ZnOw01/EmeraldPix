import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_KEY,
  getCurrentTheme,
  getThemePreference,
  initTheme,
  resetThemePreference,
  setThemePreference,
  toggleTheme
} from '../src/shared/theme';

type StorageRecord = Record<string, unknown>;

describe('theme helpers', () => {
  let chromeState: StorageRecord;
  let localState: Map<string, string>;
  let systemTheme: 'light' | 'dark';
  let metaThemeColor: {
    name?: string;
    content?: string;
    setAttribute: (name: string, value: string) => void;
  } | null;

  beforeEach(() => {
    chromeState = {};
    localState = new Map<string, string>();
    systemTheme = 'dark';
    metaThemeColor = null;

    const documentMock = {
      documentElement: { dataset: {} as Record<string, string> },
      head: {
        appendChild: (element: {
          name?: string;
          content?: string;
          setAttribute: (name: string, value: string) => void;
        }) => {
          metaThemeColor = element;
          return element;
        }
      },
      querySelector: (selector: string) => {
        if (selector === 'meta[name="theme-color"]') {
          return metaThemeColor;
        }
        return null;
      },
      createElement: () => ({
        setAttribute(name: string, value: string) {
          (this as unknown as Record<string, string>)[name] = value;
        }
      })
    };

    const localStorageMock = {
      getItem: (key: string) => localState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localState.set(key, value);
      },
      removeItem: (key: string) => {
        localState.delete(key);
      }
    };

    const chromeMock = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: chromeState[key] })),
          set: vi.fn(async (value: StorageRecord) => {
            chromeState = { ...chromeState, ...value };
          }),
          remove: vi.fn(async (key: string) => {
            delete chromeState[key];
          })
        }
      }
    };

    const windowMock = {
      matchMedia: vi.fn(() => ({ matches: systemTheme === 'dark' }))
    };

    vi.stubGlobal('document', documentMock);
    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('chrome', chromeMock);
    vi.stubGlobal('window', windowMock);
  });

  it('falls back to the system preference when no override is stored', async () => {
    await expect(getThemePreference()).resolves.toBe('system');
    await expect(getCurrentTheme()).resolves.toBe('dark');
    expect(localState.has(THEME_KEY)).toBe(false);
  });

  it('stores explicit overrides and applies them immediately', async () => {
    await setThemePreference('light');

    expect(chromeState[THEME_KEY]).toBe('light');
    expect(localState.get(THEME_KEY)).toBe('light');
    expect(
      (document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset
        .theme
    ).toBe('light');
    expect(metaThemeColor?.content).toBe('#f8fffe');
  });

  it('resetThemePreference clears the override and reapplies the system theme', async () => {
    chromeState[THEME_KEY] = 'light';
    localState.set(THEME_KEY, 'light');

    await expect(resetThemePreference()).resolves.toBe('dark');
    expect(chromeState[THEME_KEY]).toBeUndefined();
    expect(localState.has(THEME_KEY)).toBe(false);
    expect(
      (document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset
        .theme
    ).toBe('dark');
    expect(metaThemeColor?.content).toBe('#07110d');
  });

  it('toggleTheme switches from dark to light when the current theme is dark', async () => {
    // Default setup: no stored preference, system theme is 'dark'
    const result = await toggleTheme();
    expect(result).toBe('light');
    expect(chromeState[THEME_KEY]).toBe('light');
    expect(localState.get(THEME_KEY)).toBe('light');
  });

  it('toggleTheme switches from light to dark when the current theme is light', async () => {
    chromeState[THEME_KEY] = 'light';
    const result = await toggleTheme();
    expect(result).toBe('dark');
    expect(chromeState[THEME_KEY]).toBe('dark');
  });

  it('setThemePreference("system") removes the stored preference and applies the system theme', async () => {
    chromeState[THEME_KEY] = 'light';
    localState.set(THEME_KEY, 'light');
    await setThemePreference('system');
    // chrome.storage keeps 'system' as the preference value
    expect(chromeState[THEME_KEY]).toBe('system');
    // localStorage is cleared when preference is 'system'
    expect(localState.has(THEME_KEY)).toBe(false);
    // The resolved theme is the system theme (dark in this test)
    expect(
      (document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset
        .theme
    ).toBe('dark');
  });

  it('initTheme applies and returns the current resolved theme', async () => {
    // No stored preference, system theme = 'dark'
    const result = await initTheme();
    expect(result).toBe('dark');
    expect(
      (document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset
        .theme
    ).toBe('dark');
    expect(metaThemeColor?.content).toBe('#07110d');
  });

  it('ignores stale localStorage when chrome.storage has no persisted preference', async () => {
    localState.set(THEME_KEY, 'light');

    await expect(getThemePreference()).resolves.toBe('system');
    expect(localState.has(THEME_KEY)).toBe(false);
  });

  it('does not mutate local state or DOM when persisting the theme preference fails', async () => {
    const chromeMock = chrome as unknown as {
      storage: {
        local: {
          set: ReturnType<typeof vi.fn>;
        };
      };
    };
    chromeMock.storage.local.set.mockRejectedValueOnce(new Error('write failed'));

    await expect(setThemePreference('light')).rejects.toThrow('write failed');
    expect(localState.has(THEME_KEY)).toBe(false);
    expect(
      (document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset
        .theme
    ).toBeUndefined();
  });

  it('does not clear the local override when removing the persisted preference fails', async () => {
    chromeState[THEME_KEY] = 'light';
    localState.set(THEME_KEY, 'light');

    const chromeMock = chrome as unknown as {
      storage: {
        local: {
          remove: ReturnType<typeof vi.fn>;
        };
      };
    };
    chromeMock.storage.local.remove.mockRejectedValueOnce(new Error('remove failed'));

    await expect(resetThemePreference()).rejects.toThrow('remove failed');
    expect(localState.get(THEME_KEY)).toBe('light');
    expect(chromeState[THEME_KEY]).toBe('light');
  });
});
