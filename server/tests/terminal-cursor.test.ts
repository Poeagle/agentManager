import { describe, expect, it } from 'vitest';
import {
  parseTmuxCursorState,
  tmuxCursorRestoreSequence,
} from '../src/lib/terminal-cursor.js';

describe('tmux cursor snapshot restoration', () => {
  it('converts tmux coordinates into a visible ANSI cursor position', () => {
    expect(parseTmuxCursorState('2,52,1\n')).toEqual({ x: 2, y: 52, visible: true });
    expect(tmuxCursorRestoreSequence('2,52,1\n')).toBe('\x1b[?6l\x1b[53;3H\x1b[?25h');
  });

  it('preserves a hidden tmux cursor', () => {
    expect(tmuxCursorRestoreSequence('8,4,0')).toBe('\x1b[?6l\x1b[5;9H\x1b[?25l');
  });

  it('ignores malformed tmux output', () => {
    expect(parseTmuxCursorState('missing')).toBeNull();
    expect(tmuxCursorRestoreSequence('-1,2,1')).toBe('');
  });
});
