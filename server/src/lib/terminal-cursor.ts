export interface TmuxCursorState {
  x: number;
  y: number;
  visible: boolean;
}

/** Parse `#{cursor_x},#{cursor_y},#{cursor_flag}` from tmux. */
export function parseTmuxCursorState(output: string): TmuxCursorState | null {
  const match = /^(\d+),(\d+),([01])$/.exec(output.trim());
  if (!match) return null;

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    visible: match[3] === '1',
  };
}

/**
 * Recreate tmux's cursor state after a capture-pane text replay. tmux reports
 * zero-based coordinates; ANSI CUP uses one-based viewport coordinates.
 */
export function tmuxCursorRestoreSequence(output: string): string {
  const cursor = parseTmuxCursorState(output);
  if (!cursor) return '';

  const visibility = cursor.visible ? '\x1b[?25h' : '\x1b[?25l';
  return `\x1b[?6l\x1b[${cursor.y + 1};${cursor.x + 1}H${visibility}`;
}
