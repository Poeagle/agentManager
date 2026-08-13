import { describe, expect, it } from 'vitest';
import { buildIncrementalDisplayReplay } from '../src/services/session-manager.js';

describe('terminal incremental display replay', () => {
  const frames = [
    { seq: 4, data: 'old' },
    { seq: 5, data: 'hello ' },
    { seq: 6, data: 'world' },
  ];

  it('returns only contiguous output after the browser cursor', () => {
    expect(buildIncrementalDisplayReplay(frames, 6, 4)).toEqual({
      data: 'hello world',
      cursor: 6,
    });
    expect(buildIncrementalDisplayReplay(frames, 6, 6)).toEqual({ data: '', cursor: 6 });
  });

  it('requires a full snapshot when the cursor is stale, from another server generation, or too much output accumulated', () => {
    expect(buildIncrementalDisplayReplay(frames, 6, 2)).toBeNull();
    expect(buildIncrementalDisplayReplay(frames, 6, 7)).toBeNull();
    expect(buildIncrementalDisplayReplay(frames, 6, 4, 5)).toBeNull();
  });
});
