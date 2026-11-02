import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Session } from './api';

export interface SessionResumeState {
  action?:'resume'|'reload'|'new';
  phase: 'starting' | 'connecting' | 'ready' | 'error';
  startedAt: number;
  error?: string;
  warning?:string;
}

/** Keep feedback alive across the history-to-terminal transition. */
export function useSessionResume(projectId: string) {
  const queryClient = useQueryClient();
  const [states, setStates] = useState<Record<string, SessionResumeState>>({});
  const pending = useRef(new Set<string>());
  const replacing=useRef(new Set<string>());
  const failedConnections = useRef(new Set<string>());
  const successTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = successTimers.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); };
  }, []);

  const run = useCallback(async (sessionId: string,action:'resume'|'reload'|'new') => {
    // A ref guards double clicks before React has painted the disabled button.
    if (pending.current.has(sessionId)) return;
    pending.current.add(sessionId);
    if(action!=='resume')replacing.current.add(sessionId);
    failedConnections.current.delete(sessionId);
    const timer = successTimers.current.get(sessionId);
    if (timer) clearTimeout(timer);
    successTimers.current.delete(sessionId);
    const startedAt = Date.now();
    setStates((current) => ({ ...current, [sessionId]: { phase: 'starting', startedAt,action } }));
    try {
      const result = await (action==='new'?api.sessions.newConversation(sessionId):action==='reload'?api.sessions.reload(sessionId):api.sessions.resume(sessionId));
      const {session}=result;
      replacing.current.delete(sessionId);
      // Both queries feed ProjectView; an old ended row must not override the
      // resumed row and leave the user looking at history after a successful POST.
      for (const queryKey of [['sessions'], ['project-sessions', projectId]]) {
        queryClient.setQueryData<{ sessions: Session[] }>(queryKey, (current) => ({
          sessions: [session, ...(current?.sessions ?? []).filter((row) => row.id !== sessionId)],
        }));
      }
      setStates((current) => ({ ...current, [sessionId]: { phase: 'connecting', startedAt,action,warning:'warning' in result&&typeof result.warning==='string'?result.warning:undefined } }));
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      void queryClient.invalidateQueries({queryKey:['conversation-controls',sessionId]});
    } catch (error) {
      replacing.current.delete(sessionId);
      pending.current.delete(sessionId);
      setStates((current) => ({
        ...current,
        [sessionId]: { phase: 'error', startedAt,action,error: error instanceof Error ? error.message : 'Unable to resume session' },
      }));
      void queryClient.invalidateQueries({queryKey:['sessions']});
      void queryClient.invalidateQueries({queryKey:['project-sessions',projectId]});
      if(action!=='resume')throw error;
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
    if(replacing.current.has(sessionId))return;
    if (!pending.current.delete(sessionId)) return;
    failedConnections.current.add(sessionId);
    setStates((current) => ({
      ...current,
      [sessionId]: { ...current[sessionId], phase: 'error', error },
    }));
  }, []);

  const terminalExited = useCallback((sessionId: string) => {
    if(replacing.current.has(sessionId))return;
    const wasPending = pending.current.delete(sessionId);
    const wasConnectionFailure = failedConnections.current.delete(sessionId);
    if (!wasPending && !wasConnectionFailure) return;
    setStates((current) => ({
      ...current,
      [sessionId]: { ...current[sessionId], phase: 'error', error: 'The session exited before the terminal connected. Try Resume again.' },
    }));
  }, []);

  const forget = useCallback((sessionId: string) => {
    replacing.current.delete(sessionId);
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

  const resume=useCallback((id:string)=>run(id,'resume'),[run]);
  const reload=useCallback((id:string)=>run(id,'reload'),[run]);
  const newConversation=useCallback((id:string)=>run(id,'new'),[run]);
  return { states, resume,reload,newConversation, terminalReady, terminalExited, terminalFailed, forget };
}
