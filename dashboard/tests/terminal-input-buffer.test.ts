import { describe, expect, it } from 'vitest';
import { TerminalInputBuffer } from '../src/lib/terminal-input-buffer';

describe('TerminalInputBuffer', () => {
  it('preserves keyboard and paste input order across a reconnect handshake', () => {
    const buffer = new TerminalInputBuffer(64);
    expect(buffer.enqueue({ data: 'a', paste: false })).toBe(true);
    expect(buffer.enqueue({ data: '粘贴内容', paste: true })).toBe(true);
    expect(buffer.drain()).toEqual([
      { data: 'a', paste: false },
      { data: '粘贴内容', paste: true },
    ]);
    expect(buffer.byteLength).toBe(0);
  });

  it('rejects input beyond the bounded reconnect window without duplicating it', () => {
    const buffer = new TerminalInputBuffer(5);
    expect(buffer.enqueue({ data: '1234', paste: false })).toBe(true);
    expect(buffer.enqueue({ data: 'x', paste: true })).toBe(false);
    expect(buffer.drain()).toEqual([{ data: '1234', paste: false }]);
  });
});
