interface DirtyEditor {
  instanceId: string;
  rootPath: string;
}

const dirtyEditors = new Map<string, DirtyEditor>();
let beforeUnloadInstalled = false;

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirtyEditors.size === 0) return;
  event.preventDefault();
  event.returnValue = '';
}

function syncBeforeUnload(): void {
  if (dirtyEditors.size > 0 && !beforeUnloadInstalled) {
    window.addEventListener('beforeunload', onBeforeUnload);
    beforeUnloadInstalled = true;
  } else if (dirtyEditors.size === 0 && beforeUnloadInstalled) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    beforeUnloadInstalled = false;
  }
}

export function setEditorDirty(instanceId: string, rootPath: string, dirty: boolean): void {
  if (dirty) dirtyEditors.set(instanceId, { instanceId, rootPath });
  else dirtyEditors.delete(instanceId);
  syncBeforeUnload();
}

export function confirmDiscardExplorer(instanceId: string): boolean {
  if (!dirtyEditors.has(instanceId)) return true;
  return window.confirm('This explorer contains unsaved file edits. Discard them and close it?');
}

export function confirmDiscardProject(rootPath: string): boolean {
  const dirty = [...dirtyEditors.values()].some((editor) => editor.rootPath === rootPath);
  if (!dirty) return true;
  return window.confirm('This project contains unsaved file edits. Discard them and close the project tab?');
}

export function confirmDiscardAllEditors(): boolean {
  if (dirtyEditors.size === 0) return true;
  return window.confirm('There are unsaved file edits. Discard them and log out?');
}
