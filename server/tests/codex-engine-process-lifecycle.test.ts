import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  processAlive,
  terminateDetachedProcess,
} from '../src/services/agents/codex/process-lifecycle.js';

describe('Codex Engine process lifecycle', () => {
  it('escalates a detached engine that ignores SIGTERM', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    expect(child.pid).toBeTypeOf('number');

    await terminateDetachedProcess(child.pid!, 'Test Engine', 100);

    expect(processAlive(child.pid!)).toBe(false);
  });
});
