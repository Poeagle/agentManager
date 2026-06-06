// Theme registry. The actual color values live in index.css under
// `:root[data-theme="<id>"]` blocks — here we only keep the id/label and a few
// representative colors for rendering swatch previews in Settings.
//
// Switching themes = setting the `data-theme` attribute on <html>; every surface
// in the app reads `var(--bg-*)` / `var(--text-*)` / `var(--accent)` so the whole
// UI re-skins from that one attribute. Accents are chosen dark enough to keep the
// hard-coded white button text readable.

export interface ThemeDef {
  id: string;
  label: string;
  /** swatch preview only — the source of truth is index.css */
  bg: string;
  panel: string;
  accent: string;
  text: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'midnight',  label: 'Midnight',  bg: '#0f1117', panel: '#242833', accent: '#3b82f6', text: '#e4e8f1' },
  { id: 'light',     label: 'Light',     bg: '#ffffff', panel: '#e7e9ee', accent: '#2563eb', text: '#1a1d27' },
  { id: 'slate',     label: 'Slate',     bg: '#16181d', panel: '#2a2e36', accent: '#6366f1', text: '#e6e8ed' },
  { id: 'nord',      label: 'Nord',      bg: '#2e3440', panel: '#434c5e', accent: '#5e81ac', text: '#eceff4' },
  { id: 'dracula',   label: 'Dracula',   bg: '#282a36', panel: '#3b3e4f', accent: '#7c5cd6', text: '#f8f8f2' },
  { id: 'solarized', label: 'Solarized', bg: '#002b36', panel: '#0d4450', accent: '#268bd2', text: '#c3cdcd' },
];

export const DEFAULT_THEME = 'midnight';
export const THEME_IDS = THEMES.map((t) => t.id);

/** Apply a theme by id (falls back to the default for unknown/empty values). */
export function applyTheme(id: string | undefined | null): void {
  const theme = id && THEME_IDS.includes(id) ? id : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', theme);
}
