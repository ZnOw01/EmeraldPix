// Shared theme helpers for extension pages.
export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

export const THEME_KEY = 'emeraldpix-theme';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || isTheme(value);
}

function persistThemeLocally(theme: ThemePreference): void {
  try {
    if (theme === 'system') {
      localStorage.removeItem(THEME_KEY);
      return;
    }

    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Ignore localStorage access failures in restricted contexts.
  }
}

function readThemePreferenceFromLocalStorage(): ThemePreference | undefined {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isThemePreference(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function getSystemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function resolveTheme(themePreference: ThemePreference): Theme {
  return themePreference === 'system' ? getSystemTheme() : themePreference;
}

export async function getThemePreference(): Promise<ThemePreference> {
  try {
    const result = await chrome.storage.local.get(THEME_KEY);
    const stored = result[THEME_KEY];
    if (isThemePreference(stored)) {
      persistThemeLocally(stored);
      return stored;
    }

    persistThemeLocally('system');
    return 'system';
  } catch {
    // Fall back to local storage.
  }

  return readThemePreferenceFromLocalStorage() ?? 'system';
}

export async function getCurrentTheme(): Promise<Theme> {
  const themePreference = await getThemePreference();
  return resolveTheme(themePreference);
}

export async function applyTheme(theme: Theme): Promise<void> {
  document.documentElement.dataset.theme = theme;

  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement('meta');
    metaThemeColor.setAttribute('name', 'theme-color');
    document.head.appendChild(metaThemeColor);
  }

  metaThemeColor.setAttribute('content', theme === 'dark' ? '#07110d' : '#f8fffe');
}

export async function setThemePreference(themePreference: ThemePreference): Promise<void> {
  await chrome.storage.local.set({ [THEME_KEY]: themePreference });
  persistThemeLocally(themePreference);
  await applyTheme(resolveTheme(themePreference));
}

export async function resetThemePreference(): Promise<Theme> {
  await chrome.storage.local.remove(THEME_KEY);

  persistThemeLocally('system');

  const theme = getSystemTheme();
  await applyTheme(theme);
  return theme;
}

export async function toggleTheme(): Promise<Theme> {
  const preference = await getThemePreference();
  const currentResolved = preference === 'system' ? getSystemTheme() : preference;
  const next: Theme = currentResolved === 'dark' ? 'light' : 'dark';
  await setThemePreference(next);
  return next;
}

export async function initTheme(): Promise<Theme> {
  const theme = await getCurrentTheme();
  await applyTheme(theme);
  return theme;
}
