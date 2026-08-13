import { describe, expect, it } from 'vitest';
import { promoteWarmTerminal } from '../src/lib/warm-terminal-pool';

describe('warm terminal pool', () => {
  it('keeps the most recently used terminals and returns older entries for delayed cooling', () => {
    expect(promoteWarmTerminal(['a', 'b', 'c'], 'd', 3)).toEqual({
      recent: ['b', 'c', 'd'],
      cooling: ['a'],
    });
    expect(promoteWarmTerminal(['a', 'b', 'c'], 'b', 3)).toEqual({
      recent: ['a', 'c', 'b'],
      cooling: [],
    });
  });
});
