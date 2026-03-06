// Shared theme helpers for extension pages.
export type Theme = 'light' | 'dark' | 'auto';

export const THEME_KEY = 'emeraldpix-theme';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'auto';
}

function persistThemeLocally(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Ignore localStorage access failures in restricted contexts.
  }
}

function readThemeFromLocalStorage(): Theme | undefined {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveEffectiveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'auto' ? getSystemTheme() : theme;
}

export function getInitialThemeSync(): 'light' | 'dark' {
  const fromStorage = readThemeFromLocalStorage() ?? 'auto';
  return resolveEffectiveTheme(fromStorage);
}

export async function getCurrentTheme(): Promise<Theme> {
  try {
    const result = await chrome.storage.local.get(THEME_KEY);
    const stored = result[THEME_KEY];
    if (isTheme(stored)) {
      persistThemeLocally(stored);
      return stored;
    }
  } catch {
    // Fall back to local storage.
  }

  return readThemeFromLocalStorage() ?? 'auto';
}

export async function applyTheme(theme: Theme): Promise<void> {
  document.documentElement.dataset.theme = resolveEffectiveTheme(theme);

  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement('meta');
    metaThemeColor.setAttribute('name', 'theme-color');
    document.head.appendChild(metaThemeColor);
  }

  metaThemeColor.setAttribute(
    'content',
    resolveEffectiveTheme(theme) === 'dark' ? '#1a1a1a' : '#ffffff'
  );
}

export async function setTheme(theme: Theme): Promise<void> {
  persistThemeLocally(theme);
  await applyTheme(theme);
  await chrome.storage.local.set({ [THEME_KEY]: theme });
}

export async function toggleTheme(): Promise<Theme> {
  const current = await getCurrentTheme();
  const next: Theme = resolveEffectiveTheme(current) === 'dark' ? 'light' : 'dark';
  await setTheme(next);
  return next;
}

export async function initTheme(): Promise<Theme> {
  const theme = await getCurrentTheme();
  await applyTheme(theme);
  return theme;
}
