import { access, mkdir, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  homes: new Map<string, string>(),
  forgotten: vi.fn(),
  accountCommand: vi.fn(),
}));
vi.mock('../src/services/agents/codex/environments.js', () => ({
  getCodexEnvironment: vi.fn((id: string) => ({ id, kind: id === 'account:test' ? 'account' : id === 'native' ? 'native' : 'provider' })),
  environmentConnection: vi.fn(() => ({ username: 'codex-owner', codexHome: '/home/codex/.codex' })),
}));
vi.mock('../src/services/agents/codex/account-files.js', () => ({
  localHome: vi.fn((environment: { id: string }) => fixture.homes.get(environment.id)),
  forgetEnvironmentRollout: fixture.forgotten,
}));
vi.mock('../src/services/agents/codex/account-transport.js', () => ({ accountCommand: fixture.accountCommand }));
import { purgeCodexHistory } from '../src/services/agents/codex/identity.js';

const id = '019ff001-9999-7999-8999-999999999999';
const oldId = '019ff002-9999-7999-8999-999999999999';
let root = '';

beforeEach(async () => {
  vi.clearAllMocks();
  root = `/tmp/agentmanager-codex-purge-${process.pid}-${Date.now()}`;
  fixture.homes.clear();
  fixture.homes.set('provider:xindu', join(root, 'xindu'));
  fixture.homes.set('provider:ym', join(root, 'ym'));
  await Promise.all([...fixture.homes.values()].map(home => mkdir(join(home, 'sessions'), { recursive: true })));
});
afterEach(async () => {
  const { rm } = await import('fs/promises');
  await rm(root, { recursive: true, force: true });
});

describe('Codex raw conversation purge', () => {
  it('deletes only the rollout in the historical row’s provider environment', async () => {
    const source = join(fixture.homes.get('provider:xindu')!, 'sessions', `rollout-${id}.jsonl`);
    const copied = join(fixture.homes.get('provider:ym')!, 'sessions', `rollout-${id}.jsonl`);
    const unrelated = join(fixture.homes.get('provider:xindu')!, 'sessions', `not-rollout-${id}.jsonl`);
    await Promise.all([writeFile(source, 'source'), writeFile(copied, 'other engine'), writeFile(unrelated, 'not a Codex rollout')]);

    await purgeCodexHistory({ session: { agent_environment_id: 'provider:xindu' }, nativeId: id });

    await expect(access(source)).rejects.toThrow();
    await expect(access(copied)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it('deletes the selected compacted rollout while preserving its shared history ancestor', async () => {
    const home = fixture.homes.get('provider:xindu')!;
    const compacted = join(home, 'sessions', `rollout-${id}.jsonl`);
    const ancestor = join(home, 'archived_sessions', `rollout-${oldId}.jsonl`);
    await mkdir(join(home, 'archived_sessions'), { recursive: true });
    await Promise.all([
      writeFile(compacted, JSON.stringify({ type: 'session_meta', payload: { id, history_base: { thread_id: oldId } } })),
      writeFile(ancestor, 'shared ancestor'),
    ]);

    await purgeCodexHistory({ session: { agent_environment_id: 'provider:xindu' }, nativeId: id });

    await expect(access(compacted)).rejects.toThrow();
    await expect(access(ancestor)).resolves.toBeUndefined();
  });

  it('distinguishes the historical session from the fresh session after new conversation/provider transfer', async () => {
    const source = join(fixture.homes.get('provider:xindu')!, 'sessions', `rollout-${oldId}.jsonl`);
    const target = join(fixture.homes.get('provider:ym')!, 'sessions', `rollout-${id}.jsonl`);
    await Promise.all([writeFile(source, 'old conversation'), writeFile(target, 'new copied conversation')]);

    await purgeCodexHistory({ session: { agent_environment_id: 'provider:xindu' }, nativeId: oldId });

    await expect(access(source)).rejects.toThrow();
    await expect(access(target)).resolves.toBeUndefined();
  });

  it('deletes the source rollout for an account engine through the account transport', async () => {
    fixture.accountCommand.mockResolvedValue('1');
    await purgeCodexHistory({ session: { agent_environment_id: 'account:test' }, nativeId: id });
    expect(fixture.accountCommand).toHaveBeenCalledOnce();
    const script = fixture.accountCommand.mock.calls[0][1] as string;
    expect(script).toContain('archived_sessions');
    expect(script).toContain(`${id}.jsonl`);
    expect(script).toContain('path.is_symlink()');
    expect(fixture.forgotten).toHaveBeenCalledWith('account:test', id);
  });

  it('refuses to follow a symlinked history root', async () => {
    const home = fixture.homes.get('provider:xindu')!;
    const elsewhere = join(root, 'outside');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, `rollout-${id}.jsonl`), 'outside history');
    const sessions = join(home, 'sessions');
    const { rm } = await import('fs/promises');
    await rm(sessions, { recursive: true });
    await symlink(elsewhere, sessions);
    await expect(purgeCodexHistory({ session: { agent_environment_id: 'provider:xindu' }, nativeId: id })).rejects.toThrow('符号链接');
    await expect(access(join(elsewhere, `rollout-${id}.jsonl`))).resolves.toBeUndefined();
  });
});
