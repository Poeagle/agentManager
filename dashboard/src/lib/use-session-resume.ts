import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Session } from './api';

export interface SessionResumeState {
  phase: 'starting' | 'connecting' | 'ready' | 'error';
  startedAt: number;
  error?: string;
}

/** Keep feedback alive across the history-to-terminal transition. */
export function useSessionResume(projectId: string) {
  const queryClient = useQueryClient();
  const [states, setStates] = useState<Record<string, SessionResumeState>>({});
  const pending = useRef(new Set<string>());
  const failedConnections = useRef(new Set<string>());
  const successTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = successTimers.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); };
  }, []);

  const resume = useCallback(async (sessionId: string) => {
    // A ref guards double clicks before React has painted the disabled button.
    if (pending.current.has(sessionId)) return;
    pending.current.add(sessionId);
    failedConnections.current.delete(sessionId);
    const timer = successTimers.current.get(sessionId);
    if (timer) clearTimeout(timer);
    successTimers.current.delete(sessionId);
    const startedAt = Date.now();
    setStates((current) => ({ ...current, [sessionId]: { phase: 'starting', startedAt } }));
    try {
      const { session } = await api.sessions.resume(sessionId);
      // Both queries feed ProjectView; an old ended row must not override the
      // resumed row and leave the user looking at history after a successful POST.
      for (const queryKey of [['sessions'], ['project-sessions', projectId]]) {
        queryClient.setQueryData<{ sessions: Session[] }>(queryKey, (current) => ({
          sessions: [session, ...(current?.sessions ?? []).filter((row) => row.id !== sessionId)],
        }));
      }
      setStates((current) => ({ ...current, [sessionId]: { phase: 'connecting', startedAt } }));
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    } catch (error) {
      pending.current.delete(sessionId);
      setStates((current) => ({
        ...current,
        [sessionId]: { phase: 'error', startedAt, error: error instanceof Error ? error.message : 'Unable to resume session' },
      }));
    }
  }, [projectId, queryClient]);

  const terminalReady = useCallback((sessionId: string) => {
    const wasPending = pending.current.delete(sessionId);
    const wasConnectionFailure = failedConnections.current.delete(sessionId);
    if (!wasPending && !wasConnectionFailure) return;
    setStates((current) => ({ ...current, [sessionId]: { ...current[sessionId], phase: 'ready' } }));
    successTimers.current.set(sessionId, setTimeout(() => {
      setStates((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      successTimers.current.delete(sessionId);
    }, 3000));
  }, []);

  const terminalFailed = useCallback((sessionId: string, error: string) => {
    if (!pending.current.delete(sessionId)) return;
    failedConnections.current.add(sessionId);
    setStates((current) => ({
      ...current,
      [sessionId]: { ...current[sessionId], phase: 'error', error },
    }));
  }, []);

  const terminalExited = useCallback((sessionId: string) => {
    const wasPending = pending.current.delete(sessionId);
    const wasConnectionFailure = failedConnections.current.delete(sessionId);
    if (!wasPending && !wasConnectionFailure) return;
    setStates((current) => ({
      ...current,
      [sessionId]: { ...current[sessionId], phase: 'error', error: 'The session exited before the terminal connected. Try Resume again.' },
    }));
  }, []);

  const forget = useCallback((sessionId: string) => {
    pending.current.delete(sessionId);
    failedConnections.current.delete(sessionId);
    const timer = successTimers.current.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    successTimers.current.delete(sessionId);
    setStates((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  return { states, resume, terminalReady, terminalExited, terminalFailed, forget };
}
