// Theme: light by default, dark on request. The choice lives on <html data-theme> and in localStorage.
// index.html sets the attribute before first paint with the same key and rule.
export type Theme = 'dark' | 'light';
export const THEME_KEY = 'orbit.theme';

export function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // storage blocked: the theme still applies for this page view
  }
}
