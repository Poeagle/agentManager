import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmDiscardAllEditors,
  confirmDiscardExplorer,
  confirmDiscardProject,
  setEditorDirty,
} from '../src/lib/unsaved-files';

const testIds = ['explorer-a', 'explorer-b'];

afterEach(() => {
  for (const id of testIds) setEditorDirty(id, '/project', false);
  vi.restoreAllMocks();
});

describe('unsaved editor registry', () => {
  it('only prompts for the affected explorer or project', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    setEditorDirty('explorer-a', '/project', true);

    expect(confirmDiscardExplorer('explorer-b')).toBe(true);
    expect(confirmDiscardProject('/other')).toBe(true);
    expect(confirmDiscardExplorer('explorer-a')).toBe(false);
    expect(confirmDiscardProject('/project')).toBe(false);
    expect(confirmDiscardAllEditors()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('stops prompting once all edits are clean', () => {
    const confirm = vi.spyOn(window, 'confirm');
    setEditorDirty('explorer-a', '/project', true);
    setEditorDirty('explorer-a', '/project', false);

    expect(confirmDiscardAllEditors()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
