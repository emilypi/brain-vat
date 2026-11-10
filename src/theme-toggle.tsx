import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'brain-vat-theme';
const SYSTEM_THEME = '(prefers-color-scheme: dark)';

function readPreference(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function readTheme(): Theme {
  return readPreference() ?? (matchMedia(SYSTEM_THEME).matches ? 'dark' : 'light');
}

// Set the palette before React mounts, including in the packaged side panel.
document.documentElement.dataset.theme = readTheme();

export function ThemeToggle({
  compact = false,
}: {
  compact?: boolean;
}): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const system = matchMedia(SYSTEM_THEME);
    const syncPreference = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY || event.key === null) setTheme(readTheme());
    };
    const syncSystem = (): void => {
      if (readPreference() === null) setTheme(readTheme());
    };
    window.addEventListener('storage', syncPreference);
    system.addEventListener('change', syncSystem);
    return () => {
      window.removeEventListener('storage', syncPreference);
      system.removeEventListener('change', syncSystem);
    };
  }, []);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${nextTheme} mode`;
  return (
    <button
      className={'theme-toggle' + (compact ? ' theme-toggle-compact' : '')}
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(nextTheme);
        try {
          localStorage.setItem(STORAGE_KEY, nextTheme);
        } catch {
          // The toggle still works when browser storage is unavailable.
        }
      }}
    >
      {theme === 'dark' ? (
        <Sun size={15} aria-hidden="true" />
      ) : (
        <Moon size={15} aria-hidden="true" />
      )}
      {!compact && <span>{nextTheme === 'dark' ? 'Dark' : 'Light'}</span>}
    </button>
  );
}
