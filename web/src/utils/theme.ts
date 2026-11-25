export type ThemeMode = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 's3_theme_mode';

export function getSavedThemeMode(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto';
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  const h = new Date().getHours();
  return h >= 9 && h < 18 ? 'light' : 'dark';
}

export function applyThemeMode(mode: ThemeMode): 'light' | 'dark' {
  localStorage.setItem(STORAGE_KEY, mode);
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function chartPalette() {
  const dk = document.documentElement.dataset.theme === 'dark';
  return dk
    ? {
        dk: true,
        bg: '#111114',
        frame: '#27272a',
        gridH: '#1e1e22',
        gridV: '#18181b',
        tick: '#52525b',
        lbl: '#71717a',
        ink: '#fafafa',
        sec: '#a1a1aa',
        red: '#ff1f33',
        stem: '#3f3f46',
        dotBg: '#111114',
        tagBg: '#18181b',
        tagRedBg: '#261114',
      }
    : {
        dk: false,
        bg: '#ffffff',
        frame: '#e4e4e7',
        gridH: '#ececef',
        gridV: '#f0f0f2',
        tick: '#a1a1aa',
        lbl: '#71717a',
        ink: '#09090b',
        sec: '#71717a',
        red: '#e60012',
        stem: '#d4d4d8',
        dotBg: '#ffffff',
        tagBg: '#fafafa',
        tagRedBg: '#fff5f5',
      };
}
