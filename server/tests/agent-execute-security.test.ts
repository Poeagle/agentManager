import { afterEach, describe, expect, it } from 'vitest';
import { validateExecuteRequest } from '../src/routes/agent.js';
import { SessionStateTracker } from '../src/services/session-state.js';

const trackers: SessionStateTracker[] = [];

afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.destroy();
});

describe('agent execute boundaries', () => {
  it('bounds input and timers and treats waitFor as literal text', () => {
    expect(validateExecuteRequest({ input: 'x'.repeat(65 * 1024) })).toMatchObject({ ok: false });
    expect(validateExecuteRequest({ input: 'ok', timeout: 120_001 })).toMatchObject({ ok: false });
    expect(validateExecuteRequest({ input: 'ok', quiescenceMs: 30_001 })).toMatchObject({ ok: false });
    expect(validateExecuteRequest({ input: 'ok', waitFor: 'x'.repeat(513) })).toMatchObject({ ok: false });
    expect(validateExecuteRequest({ input: 'ok', waitFor: '(a+)+$' })).toMatchObject({
      ok: true,
      request: { waitFor: '(a+)+$' },
    });
  });

  it('matches metacharacters literally without running a user regex', async () => {
    const tracker = new SessionStateTracker('literal-wait');
    trackers.push(tracker);
    const execution = tracker.execute({
      input: 'run',
      waitFor: '(a+)+$',
      timeout: 1_000,
      quiescenceMs: 500,
      stripAnsi: true,
    });
    await execution.ready;
    tracker.onData(`prefix (a+)+$ suffix`);

    await expect(execution.result).resolves.toMatchObject({ status: 'pattern_matched' });
  });

  it('reserves the execute slot synchronously before JSONL preparation', async () => {
    const tracker = new SessionStateTracker('concurrent-execute');
    trackers.push(tracker);
    const first = tracker.execute({
      input: 'first', timeout: 1_000, quiescenceMs: 100, stripAnsi: true,
    });
    expect(() => tracker.execute({
      input: 'second', timeout: 1_000, quiescenceMs: 100, stripAnsi: true,
    })).toThrow('pending execute');
    await first.ready;
    tracker.cancelExecute();
    await expect(first.result).rejects.toThrow('cancelled');
  });

  it('bounds output retained by a pending execute', async () => {
    const tracker = new SessionStateTracker('bounded-output');
    trackers.push(tracker);
    const execution = tracker.execute({
      input: 'run',
      timeout: 1_000,
      quiescenceMs: 100,
      stripAnsi: true,
    });
    await execution.ready;
    tracker.onData('x'.repeat(400 * 1024));
    const pendingOutput = (tracker as unknown as { _pendingExecute: { output: string } })._pendingExecute.output;
    expect(pendingOutput.length).toBeLessThanOrEqual(256 * 1024);
    tracker.cancelExecute();
    await expect(execution.result).rejects.toThrow('cancelled');
  });
});
