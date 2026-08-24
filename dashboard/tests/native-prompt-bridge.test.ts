import { describe, expect, it } from 'vitest';
import { extractComposerDraft, NativePromptBridge } from '../src/lib/native-prompt-bridge';

describe('NativePromptBridge', () => {
  it('tracks typing, pasting, cursor edits, and enter as one native draft', () => {
    const bridge = new NativePromptBridge();
    bridge.record('fix bug');
    bridge.record('\x1b[D\x1b[D\x1b[D');
    bridge.record('the ');
    bridge.record('\x05');
    bridge.record('\nwith tests', true);
    expect(bridge.snapshot()?.text).toBe('fix the bug\nwith tests');
    bridge.record('\r');
    expect(bridge.snapshot()).toBeNull();
  });

  it('fails closed after a terminal shortcut it cannot safely model', () => {
    const bridge = new NativePromptBridge();
    bridge.record('draft');
    bridge.record('\x1b[A');
    expect(bridge.snapshot()).toBeNull();
  });

  it('keeps emoji edits as whole characters', () => {
    const bridge = new NativePromptBridge();
    bridge.record('修复 🐛x');
    bridge.record('\x7f\x7f');
    expect(bridge.snapshot()?.text).toBe('修复 ');
  });

  it('recovers an existing Codex/Claude composer from its visible wrapped rows', () => {
    expect(extractComposerDraft(['  › 修复登录超时', '    并补齐测试'])).toBe('修复登录超时\n    并补齐测试');
    expect(extractComposerDraft(['详细设计，然后补齐能力'])).toBe('详细设计，然后补齐能力');
    expect(extractComposerDraft(['   '])).toBeNull();
  });
});
