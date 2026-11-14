import { useEffect, useMemo, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'oa_theme';
const EVENT = 'oa:theme';

const current = (): Theme => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

function saved(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // The browser's own UI (the address bar on phones) follows the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f1115' : '#f4f5f7');
  window.dispatchEvent(new Event(EVENT));
}

/** Once, at startup: until a theme is picked, keep following the system setting as it changes. */
export function initTheme() {
  apply(current());
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', () => !saved() && apply(media.matches ? 'dark' : 'light'));
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  apply(theme);
}

/** The theme on screen. */
export function useTheme(): Theme {
  const [theme, set] = useState<Theme>(current);
  useEffect(() => {
    const sync = () => set(current());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return theme;
}

const rgb = (name: string) => `rgb(${getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()})`;

/** Chart colours for the current theme, read from the same CSS variables as the rest of the page. */
export function useChartColors() {
  const theme = useTheme();
  return useMemo(
    () => ({
      visitors: rgb('visitors'),
      revenue: rgb('revenue'),
      grid: rgb('stone-100'),
      axis: rgb('stone-400'),
      surface: rgb('surface'),
      cursor: rgb('stone-100'),
      theme,
    }),
    [theme],
  );
}
