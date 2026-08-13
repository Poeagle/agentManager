import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSandboxCommand,
  classifyTerminalOutput,
  PendingWorkerControls,
  setOutputSourcesPaused,
} from '../src/services/pty-worker.js';
import {
  commitPendingPtyInserts,
  boundTmuxPaneCapture,
  composeTmuxHistoryRecovery,
  frameTmuxCapture,
  finalizeReplayThroughSeq,
  flushPendingPtyOutputWithRetry,
  PendingPtyInsertBuffer,
  RESIZE_MARKER,
  serializeTmuxPaneCapture,
  sensitiveHostPathsForSandbox,
  shouldDetachSessionOnShutdown,
} from '../src/services/session-manager.js';

describe('PTY worker startup controls', () => {
  it('buffers immediate input in FIFO order and keeps only the latest startup resize', () => {
    const controls = new PendingWorkerControls(32);
    expect(controls.enqueueInput('first')).toBe(true);
    expect(controls.setResize(100, 30)).toBe(true);
    expect(controls.enqueueInput('second', true)).toBe(true);
    expect(controls.setResize(120, 40)).toBe(true);

    expect(controls.takeResize()).toEqual({ cols: 120, rows: 40 });
    expect(controls.drainInputs()).toEqual([
      { data: 'first', bracketedPaste: false },
      { data: 'second', bracketedPaste: true },
    ]);
  });

  it('turns an immediate kill into a closing request and drops queued startup controls', () => {
    const controls = new PendingWorkerControls(32);
    controls.enqueueInput('do-not-run');
    controls.setResize(90, 20);
    controls.requestClose('release');
    controls.requestClose('kill');

    expect(controls.requestedClose).toBe('kill');
    expect(controls.byteLength).toBe(0);
    expect(controls.takeResize()).toBeNull();
    expect(controls.drainInputs()).toEqual([]);
  });

  it('pauses every active output source during IPC backpressure', () => {
    const pipe = { pause: vi.fn(), resume: vi.fn() };
    const direct = { pause: vi.fn(), resume: vi.fn() };
    setOutputSourcesPaused(true, false, pipe, direct);
    setOutputSourcesPaused(false, false, pipe, direct);
    expect(direct.pause).toHaveBeenCalledOnce();
    expect(direct.resume).toHaveBeenCalledOnce();
    expect(pipe.pause).not.toHaveBeenCalled();

    setOutputSourcesPaused(true, true, pipe, direct);
    setOutputSourcesPaused(false, true, pipe, direct);
    expect(pipe.pause).toHaveBeenCalledOnce();
    expect(pipe.resume).toHaveBeenCalledOnce();
    expect(direct.pause).toHaveBeenCalledTimes(2);
    expect(direct.resume).toHaveBeenCalledTimes(2);
  });

  it('uses the attached tmux stream for display and pipe-pane only for replay', () => {
    expect(classifyTerminalOutput('attached', true, 'live')).toEqual({
      type: 'output', data: 'live', track: true, persist: false,
    });
    expect(classifyTerminalOutput('pipe', true, 'durable')).toEqual({
      type: 'output', data: 'durable', display: false,
    });
    expect(classifyTerminalOutput('attached', false, 'direct')).toEqual({
      type: 'output', data: 'direct', track: true,
    });
    expect(classifyTerminalOutput('attached', true, '\x1b[?1004h')).toBeNull();
  });
});

describe('terminal shutdown durability', () => {
  it('serializes a pane without scrolling away its first row or removing blank geometry', () => {
    expect(serializeTmuxPaneCapture('top\n\nbottom\n', '<cursor>')).toBe('top\r\n\r\nbottom<cursor>');
    expect(serializeTmuxPaneCapture('top\n\n', '<cursor>')).toBe('top\r\n<cursor>');
    expect(serializeTmuxPaneCapture('\n\n')).toBe('\r\n');
  });

  it('bounds recovery history only at complete line boundaries', () => {
    expect(boundTmuxPaneCapture('short\nhistory\n', 100)).toBe('short\nhistory\n');
    expect(boundTmuxPaneCapture('old\nmiddle\ncurrent\n', 12)).toBe('\x1b[0mcurrent\n');
  });

  it('repaints the current screen without erasing reconstructed scrollback', () => {
    expect(composeTmuxHistoryRecovery('old one\nold two\n', 'current\n', '<cursor>')).toBe(
      'old one\r\nold two\x1b[H\x1b[2Jcurrent<cursor>',
    );
    expect(composeTmuxHistoryRecovery('history\n', 'screen\n')).not.toContain('\x1b[3J');
  });

  it('preserves browser scrollback for routine screen refreshes', () => {
    expect(frameTmuxCapture('screen', 'current')).toBe('\x1b[H\x1b[2Jcurrent');
    expect(frameTmuxCapture('screen', 'current')).not.toContain('\x1b[3J');
    expect(frameTmuxCapture('history', 'all history')).toBe('\x1b[H\x1b[2J\x1b[3Jall history');
  });

  it('detaches only sessions backed by tmux, dtach, or an external socket', () => {
    expect(shouldDetachSessionOnShutdown(false, false)).toBe(false);
    expect(shouldDetachSessionOnShutdown(true, false)).toBe(true);
    expect(shouldDetachSessionOnShutdown(false, true)).toBe(true);
    expect(shouldDetachSessionOnShutdown(false, false, '/tmp/external.sock')).toBe(true);
  });
});

describe('member PTY sandbox', () => {
  it('uses a private tmp and masks explicit host paths only for sandboxed members', () => {
    const member = buildSandboxCommand(
      'session-1', '/project', '/bin/sh', ['-i'],
      ['/other-project', '-/home/member/.ssh'], true,
    );
    expect(member.program).toBe('systemd-run');
    expect(member.args).toContain('PrivateTmp=yes');
    expect(member.args).toContain('InaccessiblePaths=/other-project');
    expect(member.args).toContain('InaccessiblePaths=-/home/member/.ssh');

    expect(buildSandboxCommand('session-1', '/project', '/bin/sh', ['-i'], [], false)).toEqual({
      program: '/bin/sh',
      args: ['-i'],
    });
  });

  it('includes the service DB directory and common credential paths', () => {
    expect(sensitiveHostPathsForSandbox('/state/agentmanager.db', '/home/member')).toEqual([
      dirname(resolve('/state/agentmanager.db')),
      '-/home/member/.ssh',
      '-/home/member/.gnupg',
      '-/home/member/.aws',
      '-/home/member/.kube',
      '-/home/member/.config/gh',
      '-/home/member/.netrc',
      '-/home/member/.npmrc',
    ]);
  });
});

describe('PTY persistence races', () => {
  it('retains batches after a failed flush and clears them only after commit succeeds', () => {
    const buffer = new PendingPtyInsertBuffer(1024);
    buffer.enqueue({ sessionId: 'one', seq: 1, data: 'a' });
    buffer.enqueue({ sessionId: 'one', seq: 2, data: 'b' });
    const failed = vi.fn(() => { throw new Error('locked'); });

    expect(commitPendingPtyInserts(buffer, failed)).toBe(false);
    expect(buffer.coalesced()).toEqual([{ sessionId: 'one', seq: 2, data: 'ab' }]);
    expect(buffer.byteLength).toBe(2);

    const committed = vi.fn();
    expect(commitPendingPtyInserts(buffer, committed)).toBe(true);
    expect(committed).toHaveBeenCalledWith([{ sessionId: 'one', seq: 2, data: 'ab' }]);
    expect(buffer.size).toBe(0);
  });

  it('discards only the killed session before a delayed flush and fixes byte accounting', () => {
    const buffer = new PendingPtyInsertBuffer(1024);
    buffer.enqueue({ sessionId: 'killed', seq: 1, data: 'dead' });
    buffer.enqueue({ sessionId: 'alive', seq: 1, data: 'keep' });
    buffer.discard('killed');

    expect(buffer.byteLength).toBe(Buffer.byteLength('keep'));
    expect(buffer.coalesced()).toEqual([{ sessionId: 'alive', seq: 1, data: 'keep' }]);
  });

  it('keeps resize markers as independent ordered rows while coalescing output', () => {
    const buffer = new PendingPtyInsertBuffer(1024);
    buffer.enqueue({ sessionId: 'one', seq: 1, data: 'before-a' });
    buffer.enqueue({ sessionId: 'one', seq: 2, data: 'before-b' });
    buffer.enqueue({ sessionId: 'one', seq: 3, data: `${RESIZE_MARKER}120,40` });
    buffer.enqueue({ sessionId: 'one', seq: 4, data: 'after-a' });
    buffer.enqueue({ sessionId: 'one', seq: 5, data: 'after-b' });

    expect(buffer.coalesced()).toEqual([
      { sessionId: 'one', seq: 2, data: 'before-abefore-b' },
      { sessionId: 'one', seq: 3, data: `${RESIZE_MARKER}120,40` },
      { sessionId: 'one', seq: 5, data: 'after-aafter-b' },
    ]);
  });

  it('does not let a delayed exit snapshot delete immediately resumed output', async () => {
    const rows = [{ seq: 1, data: 'old-output' }];
    let finishCapture!: () => void;
    const captured: string[] = [];
    const finalizing = finalizeReplayThroughSeq(
      1,
      async (maxSeq) => {
        await new Promise<void>((resolve) => { finishCapture = resolve; });
        captured.push(...rows.filter((row) => row.seq <= maxSeq).map((row) => row.data));
        return true;
      },
      (maxSeq) => {
        for (let index = rows.length - 1; index >= 0; index--) {
          if (rows[index].seq <= maxSeq) rows.splice(index, 1);
        }
      },
    );

    await vi.waitFor(() => expect(finishCapture).toBeTypeOf('function'));
    rows.push({ seq: 2, data: 'resumed-output' });
    finishCapture();
    await finalizing;
    expect(captured).toEqual(['old-output']);
    expect(rows).toEqual([{ seq: 2, data: 'resumed-output' }]);
  });

  it('keeps replay rows when final snapshot capture fails', async () => {
    const remove = vi.fn();
    expect(await finalizeReplayThroughSeq(7, async () => false, remove)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('retries graceful-shutdown flushes and reports a persistent failure', async () => {
    const eventually = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    expect(await flushPendingPtyOutputWithRetry(4, 0, eventually)).toBe(true);
    expect(eventually).toHaveBeenCalledTimes(3);

    const failing = vi.fn(() => false);
    expect(await flushPendingPtyOutputWithRetry(3, 0, failing)).toBe(false);
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it('does not let periodic pruning delete rows owned by an exit finalizer', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'src', 'services', 'session-manager.ts'), 'utf8');
    const prune = source.slice(source.indexOf('function prunePtyOutput'), source.indexOf('function readRecentOutput'));
    expect(prune).not.toContain("status IN ('completed', 'cancelled', 'failed')");
  });
});

describe('adopt sizing', () => {
  it('does not schedule a synthetic cols-minus-one redraw resize', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'src', 'services', 'pty-worker.ts'), 'utf8');
    const adopt = source.slice(source.indexOf('async function handleAdopt'), source.indexOf('function handleInput'));
    expect(adopt).not.toContain('cols - 1');
    expect(adopt).not.toContain("'resize-pane'");
  });
});
