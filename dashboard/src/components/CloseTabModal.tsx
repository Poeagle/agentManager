import { useEffect, useRef } from 'react';
import { AlertTriangle, EyeOff, Power } from 'lucide-react';

interface CloseTabModalProps {
  /** e.g. "Session 1", "Terminal 2" */
  label: string;
  /** e.g. "session", "terminal", "project" */
  type: 'session' | 'terminal' | 'agent' | 'project';
  /** Number of running sessions (only for project type) */
  sessionCount?: number;
  /** Called when user picks "Hide Tab" */
  onHide: () => void;
  /** Called when user picks "Close & Kill" */
  onKill: () => void;
  /** Called when user cancels */
  onCancel: () => void;
}

export function CloseTabModal({
  label,
  type,
  sessionCount,
  onHide,
  onKill,
  onCancel,
}: CloseTabModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Default focus on Cancel — Enter on a destructive action is too easy to
    // trigger accidentally when the modal pops up from a stray shortcut.
    cancelRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onCancel]);

  const isProject = type === 'project';

  const message = isProject
    ? `此项目有 ${sessionCount} 个会话正在运行。隐藏标签会让它们继续在后台运行；关闭并终止会停止这些会话。两种操作均保留会话历史。`
    : `“${label}”仍在运行。隐藏标签会让它继续在后台运行；关闭并终止会停止进程，但保留会话历史。`;


  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onCancel}
    >
      <div
        className="flex flex-col rounded-lg shadow-2xl overflow-hidden"
        style={{
          width: '100%',
          maxWidth: '420px',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-2">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-full shrink-0"
            style={{ background: '#f59e0b20' }}
          >
            <AlertTriangle className="w-5 h-5" style={{ color: '#f59e0b' }} />
          </div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            关闭{isProject ? '项目标签' : `“${label}”`}
          </h3>
        </div>

        {/* Body */}
        <div className="px-5 py-3">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {message}
          </p>
          <p className="mt-2 text-xs leading-relaxed" style={{color:'var(--text-muted)'}}>若要永久删除，请在会话结束后，进入“项目会话记录”选择“删除记录”。</p>
        </div>

        {/* Actions */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}
          >
            取消
          </button>
          <button
            onClick={onHide}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
            }}
          >
            <EyeOff className="w-3 h-3" />
            仅隐藏标签
          </button>
          <button
            onClick={onKill}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            style={{
              background: '#ef4444',
              color: '#fff',
              border: 'none',
            }}
          >
            <Power className="w-3 h-3" />
            关闭并终止
          </button>
        </div>
      </div>
    </div>
  );
}
