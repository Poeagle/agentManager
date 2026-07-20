import { createElement } from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  displayCombo,
  eventToCombo,
  findActionByCombo,
  installShortcutDispatcher,
  isEditableTarget,
  isKeyboardNavActive,
  isSuspended,
  isValidCombo,
  markKeyboardNav,
  normalizeKey,
  pushSuspend,
  resolveCombo,
  useShortcut,
  useShortcutStore,
} from '../src/lib/shortcuts';

afterEach(() => {
  useShortcutStore.getState().setBindings({});
  vi.useRealTimers();
});

describe('keyboard shortcut normalization', () => {
  it('normalizes physical events and platform-aware mod bindings', () => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true });
    expect(eventToCombo(event)).toBe('ctrl+shift+arrowright');
    expect(resolveCombo('mod+shift+arrowright')).toBe('ctrl+shift+arrowright');
    expect(displayCombo('mod+shift+arrowright')).toBe('Ctrl+Shift+➡');
    expect(normalizeKey(' ')).toBe('space');
  });

  it('rejects unsafe or incomplete custom bindings', () => {
    expect(isValidCombo('ctrl+k')).toBe(true);
    expect(isValidCombo('shift+k')).toBe(false);
    expect(isValidCombo('ctrl+shift')).toBe(false);
    expect(resolveCombo('')).toBe('');
    expect(displayCombo(null)).toBe('Unbound');
    expect(eventToCombo(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))).toBe('');
    expect(normalizeKey('Escape')).toBe('escape');
  });
});

describe('editable target detection', () => {
  it('protects text inputs, textareas and xterm helpers', () => {
    const input = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const textarea = document.createElement('textarea');
    const readonly = document.createElement('textarea');
    readonly.readOnly = true;
    const contentEditable = document.createElement('div');
    Object.defineProperty(contentEditable, 'isContentEditable', { value: true });
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('span');
    xterm.appendChild(helper);
    document.body.append(input, checkbox, textarea, readonly, contentEditable, xterm);

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(readonly)).toBe(false);
    expect(isEditableTarget(contentEditable)).toBe(true);
    expect(isEditableTarget(checkbox)).toBe(false);
    expect(isEditableTarget(helper)).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('shortcut binding persistence', () => {
  it('hydrates overrides and falls back to defaults after reset', () => {
    const store = useShortcutStore.getState();
    store.hydrate(JSON.stringify({ 'nav.nextTab': { combo: 'ctrl+k', fireInEditable: false } }));
    expect(useShortcutStore.getState().getEffective('nav.nextTab')).toEqual({ combo: 'ctrl+k', fireInEditable: false });
    useShortcutStore.getState().resetBinding('nav.nextTab');
    expect(useShortcutStore.getState().getEffective('nav.nextTab').combo).toBe('mod+shift+arrowright');
  });

  it('serializes edits, handles invalid state and detects conflicts', () => {
    useShortcutStore.getState().hydrate(undefined);
    expect(useShortcutStore.getState().loaded).toBe(true);
    useShortcutStore.getState().hydrate('{broken');
    expect(useShortcutStore.getState().bindings).toEqual({});
    useShortcutStore.getState().setBinding('nav.nextTab', { combo: 'ctrl+k' });
    expect(JSON.parse(useShortcutStore.getState().serialize())).toEqual({ 'nav.nextTab': { combo: 'ctrl+k' } });
    expect(findActionByCombo('ctrl+k')).toBe('nav.nextTab');
    expect(findActionByCombo('ctrl+k', 'nav.nextTab')).toBeNull();
  });
});

describe('shortcut dispatcher', () => {
  it('dispatches registered handlers and supports suspension', () => {
    const handler = vi.fn();
    function Harness() {
      useShortcut('nav.nextTab', handler);
      return createElement('div');
    }
    render(createElement(Harness));
    const uninstall = installShortcutDispatcher();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);

    const release = pushSuspend();
    expect(isSuspended()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    release();
    release();
    expect(isSuspended()).toBe(false);
    uninstall();
  });

  it('tracks the short keyboard-navigation focus suppression window', () => {
    vi.useFakeTimers();
    markKeyboardNav(100);
    expect(isKeyboardNavActive()).toBe(true);
    vi.advanceTimersByTime(101);
    expect(isKeyboardNavActive()).toBe(false);
  });
});
