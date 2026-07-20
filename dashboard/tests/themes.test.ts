import { describe, expect, it } from 'vitest';
import { applyTheme, DEFAULT_THEME, THEME_IDS } from '../src/lib/themes';

describe('theme application', () => {
  it('applies a known theme and falls back for unknown values', () => {
    applyTheme('light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    applyTheme('not-a-theme');
    expect(document.documentElement).toHaveAttribute('data-theme', DEFAULT_THEME);
    expect(THEME_IDS).toContain('midnight');
  });
});
