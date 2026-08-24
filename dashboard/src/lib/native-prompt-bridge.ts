export interface NativePromptSnapshot {
  text: string;
  version: number;
}

/**
 * Extracts the editable tail from a CLI composer line captured by xterm. This
 * is intentionally narrow: callers use it only for Codex/Claude recovery when
 * the browser did not observe the original keystrokes (for example after a
 * tab switch or editing a previous message).
 */
export function extractComposerDraft(lines: string[]): string | null {
  const nonEmpty = lines.map((line) => line.replace(/\u00a0/g, ' ')).join('\n').trim();
  if (!nonEmpty || nonEmpty.length > 24_000) return null;
  const firstMarker = nonEmpty.search(/[›❯]/);
  if (firstMarker >= 0) {
    const afterMarker = nonEmpty.slice(firstMarker + 1).replace(/^\s*/, '').trim();
    return afterMarker || null;
  }
  // Some terminal themes render the Codex prompt marker as a plain `>`.
  const plainMarker = nonEmpty.match(/(?:^|\n)\s*>\s?(.*)$/s);
  if (plainMarker?.[1]?.trim()) return plainMarker[1].trim();
  // When a narrow TUI wraps the first line away, the current cursor row can
  // contain only the user text. Accept that line, but only for known CLI
  // composers (the caller enforces that boundary).
  return nonEmpty;
}

/**
 * Tracks only the text edits the browser has observed entering a live xterm.
 * It intentionally fails closed when a terminal shortcut changes state in a
 * way that cannot be represented as a plain editable draft.
 */
export class NativePromptBridge {
  private chars: string[] = [];
  private cursor = 0;
  private safe = true;
  private revision = 0;

  record(data: string, paste = false): void {
    if (!data) return;
    if (paste) {
      this.insert([...data.replace(/\r\n?/g, '\n')]);
      return;
    }

    for (let offset = 0; offset < data.length;) {
      const rest = data.slice(offset);
      if (rest.startsWith('\x1b[D')) { this.move(-1); offset += 3; continue; }
      if (rest.startsWith('\x1b[C')) { this.move(1); offset += 3; continue; }
      if (rest.startsWith('\x1b[H') || rest.startsWith('\x1bOH')) { this.cursor = 0; this.bump(); offset += 3; continue; }
      if (rest.startsWith('\x1b[F') || rest.startsWith('\x1bOF')) { this.cursor = this.chars.length; this.bump(); offset += 3; continue; }
      if (rest.startsWith('\x1b[3~')) { this.deleteForward(); offset += 4; continue; }

      const code = data.codePointAt(offset);
      if (code === undefined) break;
      const char = String.fromCodePoint(code);
      offset += char.length;
      if (char === '\r') { this.clear(); continue; }
      if (char === '\x7f' || char === '\b') { this.deleteBackward(); continue; }
      if (char === '\x01') { this.cursor = 0; this.bump(); continue; } // Ctrl+A
      if (char === '\x05') { this.cursor = this.chars.length; this.bump(); continue; } // Ctrl+E
      if (char === '\x15') { this.chars.splice(0, this.cursor); this.cursor = 0; this.bump(); continue; } // Ctrl+U
      if (char === '\x0b') { this.chars.splice(this.cursor); this.bump(); continue; } // Ctrl+K
      if (char === '\x17') { this.deleteWord(); continue; } // Ctrl+W
      if (char === '\x03' || char === '\x1b' || char === '\t' || (code < 0x20 && char !== '\n')) {
        this.safe = false;
        this.bump();
        continue;
      }
      this.insert([char]);
    }
  }

  snapshot(): NativePromptSnapshot | null {
    if (!this.safe || this.chars.length === 0) return null;
    return { text: this.chars.join(''), version: this.revision };
  }

  replace(text: string): void {
    this.chars = [...text];
    this.cursor = this.chars.length;
    this.safe = true;
    this.bump();
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
    this.safe = true;
    this.bump();
  }

  invalidate(): void {
    this.safe = false;
    this.bump();
  }

  private insert(chars: string[]): void {
    if (!this.safe) return;
    this.chars.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
    this.bump();
  }

  private move(delta: number): void {
    if (!this.safe) return;
    this.cursor = Math.max(0, Math.min(this.chars.length, this.cursor + delta));
    this.bump();
  }

  private deleteBackward(): void {
    if (!this.safe || this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor--;
    this.bump();
  }

  private deleteForward(): void {
    if (!this.safe || this.cursor >= this.chars.length) return;
    this.chars.splice(this.cursor, 1);
    this.bump();
  }

  private deleteWord(): void {
    if (!this.safe || this.cursor === 0) return;
    let start = this.cursor;
    while (start > 0 && /\s/.test(this.chars[start - 1])) start--;
    while (start > 0 && !/\s/.test(this.chars[start - 1])) start--;
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
    this.bump();
  }

  private bump(): void {
    this.revision++;
  }
}
