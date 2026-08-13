export interface BufferedTerminalInput {
  data: string;
  paste: boolean;
}

/**
 * Holds the small amount of keyboard/paste input that can arrive while a
 * terminal WebSocket is reconnecting but has not completed its resize/replay
 * handshake yet.
 */
export class TerminalInputBuffer {
  private items: BufferedTerminalInput[] = [];
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 256 * 1024) {
    this.maxBytes = maxBytes;
  }

  enqueue(input: BufferedTerminalInput): boolean {
    const bytes = new TextEncoder().encode(input.data).byteLength + 1;
    if (bytes > this.maxBytes - this.bytes) return false;
    this.items.push(input);
    this.bytes += bytes;
    return true;
  }

  drain(): BufferedTerminalInput[] {
    const items = this.items;
    this.items = [];
    this.bytes = 0;
    return items;
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
  }

  get byteLength(): number {
    return this.bytes;
  }
}
