import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { SessionResumeState } from '../lib/use-session-resume';

export function SessionResumeFeedback({ state }: { state: SessionResumeState }) {
  const [now, setNow] = useState(Date.now);
  const busy = state.phase === 'starting' || state.phase === 'connecting';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy, state.startedAt]);
  const elapsed = Math.max(0, Math.floor((now - state.startedAt) / 1000));
  const failed = state.phase === 'error';
  const color = failed ? 'var(--error)' : busy ? 'var(--accent)' : 'var(--success)';
  const Icon = failed ? AlertCircle : busy ? Loader2 : CheckCircle2;

  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100%-32px)] rounded-md border px-4 py-3 text-xs shadow-lg pointer-events-none"
      style={{ background: 'var(--bg-secondary)', borderColor: color, color: 'var(--text-primary)' }}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 shrink-0 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`} style={{ color }} />
        <span className="font-medium">
          {state.phase === 'starting' ? 'Resuming — starting session…'
            : state.phase === 'connecting' ? 'Resuming — connecting terminal…'
              : failed ? 'Resume failed' : 'Session resumed'}
        </span>
        {busy && <span aria-live="off" style={{ color: 'var(--text-muted)' }}>{elapsed}s</span>}
      </div>
      {failed && <p className="mt-1.5 max-w-md break-words">{state.error}</p>}
      {busy && elapsed >= 15 && (
        <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>This is taking longer than usual. Still waiting for the session to connect.</p>
      )}
    </div>
  );
}
