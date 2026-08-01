import { describe, expect, it } from 'vitest';
import { applyDiffDraft, parseHunks } from '../src/lib/diff-model';

describe('diff model', () => {
  it('parses old and new hunk content', () => {
    const [hunk] = parseHunks([
      '@@ -2,2 +2,3 @@',
      '-old value',
      '+new value',
      '+inserted value',
      ' context',
    ].join('\n'));

    expect(hunk).toMatchObject({
      oldStart: 2,
      oldCount: 2,
      newStart: 2,
      newCount: 3,
      oldContent: ['old value', 'context'],
      newContent: ['new value', 'inserted value', 'context'],
    });
  });

  it('applies line edits before reverted hunks shift later line numbers', () => {
    const hunks = parseHunks([
      '@@ -2,1 +2,2 @@',
      '-old-a',
      '+new-a',
      '+inserted',
    ].join('\n'));
    const currentFile = ['header', 'new-a', 'inserted', 'middle', 'new-b', 'tail'].join('\n');

    const result = applyDiffDraft(
      currentFile,
      hunks,
      new Set([0]),
      new Map([[5, 'edited-b']]),
    );

    expect(result).toBe(['header', 'old-a', 'middle', 'edited-b', 'tail'].join('\n'));
  });
});
