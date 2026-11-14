import { setTheme, useTheme } from '../lib/theme';
import { MoonIcon, SunIcon } from './Icons';

/** Switches between light and dark. The choice is remembered in this browser. */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className={className} onClick={() => setTheme(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
