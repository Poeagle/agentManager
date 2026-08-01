import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_TERMINAL_INPUT_BYTES,
  PendingTerminalInputQueue,
  parseTerminalClientMessage,
} from '../src/routes/terminal.js';

describe('terminal websocket protocol', () => {
  it('accepts only validated JSON messages', () => {
    expect(parseTerminalClientMessage('{"type":"ping"}')).toEqual({
      ok: true,
      message: { type: 'ping' },
    });
    expect(parseTerminalClientMessage('{"type":"input","data":"hello"}')).toEqual({
      ok: true,
      message: { type: 'input', data: 'hello', paste: false },
    });

    expect(parseTerminalClientMessage('raw terminal input')).toEqual({
      ok: false,
      error: 'Invalid terminal message',
    });
    expect(parseTerminalClientMessage('{"type":"input","data":1}').ok).toBe(false);
    expect(parseTerminalClientMessage('{"type":"unknown"}').ok).toBe(false);
  });

  it('rejects invalid dimensions and oversized input at the websocket boundary', () => {
    expect(parseTerminalClientMessage('{"type":"resize","cols":120,"rows":40}')).toEqual({
      ok: true,
      message: { type: 'resize', cols: 120, rows: 40 },
    });
    expect(parseTerminalClientMessage('{"type":"resize","cols":0,"rows":40}').ok).toBe(false);
    expect(parseTerminalClientMessage('{"type":"resize","cols":120.5,"rows":40}').ok).toBe(false);

    const oversized = JSON.stringify({ type: 'input', data: 'x'.repeat(256 * 1024 + 1) });
    expect(parseTerminalClientMessage(oversized)).toMatchObject({
      ok: false,
      closeCode: 1009,
    });
  });

  it('bounds and drains handshake input in FIFO order', () => {
    const queue = new PendingTerminalInputQueue(8);
    expect(queue.enqueue({ data: 'ab', paste: false })).toBe(true);
    expect(queue.enqueue({ data: 'cd', paste: true })).toBe(true);
    expect(queue.enqueue({ data: 'efg', paste: false })).toBe(false);
    expect(queue.drain()).toEqual([
      { data: 'ab', paste: false },
      { data: 'cd', paste: true },
    ]);
    expect(queue.byteLength).toBe(0);

    const bounded = new PendingTerminalInputQueue();
    expect(bounded.enqueue({ data: 'x'.repeat(MAX_PENDING_TERMINAL_INPUT_BYTES), paste: false })).toBe(false);
  });
});
