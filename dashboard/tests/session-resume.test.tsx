import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { api, type Session } from '../src/lib/api';
import { useSessionResume } from '../src/lib/use-session-resume';
import { SessionResumeFeedback } from '../src/components/SessionResumeFeedback';

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, sessions: { ...actual.api.sessions, resume: vi.fn() } } };
});

const ended: Session = {
  id: 'session-1', project_id: 'project-1', task: 'Review code', status: 'completed',
  cli_type: 'codex', codex_session_id: 'native-conversation', pid: null, started_at: null,
  completed_at: '2026-10-13T03:00:00Z', exit_code: 0, created_at: '2026-10-12T00:00:00Z',
};
const resumed: Session = { ...ended, status: 'running', completed_at: null, exit_code: null };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], { sessions: [ended] });
  client.setQueryData(['project-sessions', ended.project_id], { sessions: [ended] });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useSessionResume('project-1'), { wrapper }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sessions.resume).mockResolvedValue({ ok: true, session: resumed });
});
afterEach(() => vi.useRealTimers());

describe('manual session resume feedback', () => {
  it('shows starting immediately and prevents duplicate launches through terminal readiness', async () => {
    let finish!: (value: { ok: boolean; session: Session }) => void;
    vi.mocked(api.sessions.resume).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { result } = setup();
    let request!: Promise<void>;
    act(() => {
      request = result.current.resume(ended.id);
      void result.current.resume(ended.id);
    });
    expect(result.current.states[ended.id].phase).toBe('starting');
    expect(api.sessions.resume).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, session: resumed }); await request; });
    expect(result.current.states[ended.id].phase).toBe('connecting');
    await act(() => result.current.resume(ended.id));
    expect(api.sessions.resume).toHaveBeenCalledTimes(1);
    act(() => result.current.terminalReady(ended.id));
    expect(result.current.states[ended.id].phase).toBe('ready');
  });

  it('updates both session caches so stale history cannot keep the resumed tab ended', async () => {
    const { result, client } = setup();
    await act(() => result.current.resume(ended.id));
    for (const key of [['sessions'], ['project-sessions', 'project-1']]) {
      expect(client.getQueryData(key)).toEqual({ sessions: [resumed] });
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    // HTTP success alone must not claim that the terminal is ready.
    expect(result.current.states[ended.id].phase).toBe('connecting');
  });

  it('exposes request errors and allows an explicit retry', async () => {
    vi.mocked(api.sessions.resume).mockRejectedValueOnce(new Error('Project path not found'));
    const { result, client } = setup();
    await act(() => result.current.resume(ended.id));
    expect(result.current.states[ended.id]).toMatchObject({ phase: 'error', error: 'Project path not found' });
    expect(client.getQueryData(['sessions'])).toEqual({ sessions: [ended] });
    await act(() => result.current.resume(ended.id));
    expect(api.sessions.resume).toHaveBeenCalledTimes(2);
    expect(result.current.states[ended.id].phase).toBe('connecting');
  });

  it('shows failure if the resumed process exits before the terminal becomes ready', async () => {
    const { result } = setup();
    await act(() => result.current.resume(ended.id));
    act(() => result.current.terminalExited(ended.id));
    expect(result.current.states[ended.id]).toMatchObject({ phase: 'error', error: expect.stringContaining('exited') });
    act(() => result.current.terminalReady(ended.id));
    expect(result.current.states[ended.id].phase).toBe('error');
  });

  it('clears success feedback after three seconds', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    await act(() => result.current.resume(ended.id));
    act(() => result.current.terminalReady(ended.id));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.states[ended.id]).toBeUndefined();
  });

  it('clears feedback and its timer when the session tab is closed', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    await act(() => result.current.resume(ended.id));
    const existingTimers = vi.getTimerCount();
    act(() => result.current.terminalReady(ended.id));
    expect(vi.getTimerCount()).toBe(existingTimers + 1);
    act(() => result.current.forget(ended.id));
    expect(result.current.states[ended.id]).toBeUndefined();
    expect(vi.getTimerCount()).toBe(existingTimers);
    act(() => result.current.terminalReady(ended.id));
    expect(result.current.states[ended.id]).toBeUndefined();
  });

  it('stops the pending indicator when the terminal reports a connection error', async () => {
    const { result } = setup();
    await act(() => result.current.resume(ended.id));
    act(() => result.current.terminalFailed(ended.id, 'Session not found'));
    expect(result.current.states[ended.id]).toMatchObject({ phase: 'error', error: 'Session not found' });
    act(() => result.current.terminalReady(ended.id));
    expect(result.current.states[ended.id].phase).toBe('ready');
  });

  it('shows elapsed time and a slow-connection message without inventing percentage progress', () => {
    vi.useFakeTimers();
    render(<SessionResumeFeedback state={{ phase: 'connecting', startedAt: Date.now() }} />);
    expect(screen.getByRole('status')).toHaveTextContent('connecting terminal');
    expect(screen.getByText('0s')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(15000); });
    expect(screen.getByText('15s')).toBeInTheDocument();
    expect(screen.getByText(/taking longer than usual/)).toBeInTheDocument();
  });

  it('makes a failed resume visible with the server error', () => {
    render(<SessionResumeFeedback state={{ phase: 'error', startedAt: Date.now(), error: 'Project path not found' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Resume failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Project path not found');
  });
});
