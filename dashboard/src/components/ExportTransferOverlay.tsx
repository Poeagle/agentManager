import {
  AlertTriangle,
  Archive,
  Check,
  FileDown,
  Loader2,
  OctagonX,
  X,
} from 'lucide-react';
import {
  cancelExportTransfer,
  dismissExportTransfer,
  isExportTransferActive,
  useExportTransferStore,
  type ExportTransferPhase,
} from '../lib/export-transfer';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond: number) {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—';
}

function formatDuration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return '计算中';
  if (seconds < 2) return '即将完成';
  if (seconds < 60) return `约 ${Math.ceil(seconds)} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `约 ${hours} 小时${rest ? ` ${rest} 分` : ''}`;
}

const PHASE_COPY: Record<ExportTransferPhase, { title: string; detail: string }> = {
  choosing: { title: '选择保存位置', detail: '浏览器正在等待你确认文件名和位置' },
  preparing: { title: '正在准备导出', detail: '服务端正在建立压缩数据流' },
  transferring: { title: '正在传输', detail: '可以切换页面，传输会继续在后台运行' },
  cancelling: { title: '正在取消', detail: '正在安全关闭文件和网络连接' },
  completed: { title: '导出完成', detail: '文件已完整写入所选位置' },
  cancelled: { title: '已取消导出', detail: '未完成的数据已停止写入' },
  error: { title: '导出失败', detail: '传输未能完成，请检查提示后重试' },
};

export function ExportTransferOverlay() {
  const task = useExportTransferStore((state) => state.task);
  if (!task) return null;

  const active = isExportTransferActive(task);
  const copy = PHASE_COPY[task.phase];
  const determinate = task.total !== undefined && task.total > 0;
  const ratio = determinate ? Math.min(task.loaded / task.total!, 1) : 0;
  const complete = task.phase === 'completed';
  const failed = task.phase === 'error';
  const cancelled = task.phase === 'cancelled';
  const barColor = complete
    ? 'var(--success)'
    : failed || cancelled
      ? 'var(--error)'
      : 'var(--accent)';

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center px-4 pointer-events-none"
      aria-live="polite"
    >
      <section
        className="export-transfer-console pointer-events-auto relative w-full max-w-[500px] overflow-hidden rounded-xl border"
        style={{
          color: 'var(--text-primary)',
          background: 'color-mix(in srgb, var(--bg-secondary) 94%, transparent)',
          borderColor: 'color-mix(in srgb, var(--accent) 32%, var(--border))',
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.48), 0 0 0 1px rgba(255, 255, 255, 0.025)',
          backdropFilter: 'blur(18px)',
        }}
        role="status"
        aria-label={`${copy.title}: ${task.fileName}`}
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          <div
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border"
            style={{
              color: barColor,
              background: `color-mix(in srgb, ${barColor} 11%, var(--bg-tertiary))`,
              borderColor: `color-mix(in srgb, ${barColor} 28%, var(--border))`,
            }}
          >
            {complete ? <Check className="h-5 w-5" /> : failed ? <AlertTriangle className="h-5 w-5" /> : cancelled ? <OctagonX className="h-5 w-5" /> : task.isDirectory ? <Archive className="h-5 w-5" /> : <FileDown className="h-5 w-5" />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight">{copy.title}</h2>
              {active && task.phase !== 'cancelling' && (
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-[0.16em]"
                  style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}
                >
                  LIVE
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{copy.detail}</p>
            <p className="mt-2 truncate font-mono text-xs font-medium" title={task.fileName}>{task.fileName}</p>
            <p className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }} title={task.sourcePath}>{task.sourcePath}</p>
          </div>

          {!active && (
            <button
              type="button"
              onClick={dismissExportTransfer}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
              style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
              aria-label="关闭导出状态"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="px-5">
          <div
            className="export-transfer-track relative h-2 overflow-hidden rounded-full"
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
          >
            {active && !determinate ? (
              <div className="export-transfer-indeterminate absolute inset-y-0 w-1/3 rounded-full" style={{ background: barColor }} />
            ) : (
              <div
                className="export-transfer-fill h-full rounded-full transition-[width] duration-200 ease-out"
                style={{
                  width: complete ? '100%' : failed || cancelled ? `${Math.max(ratio * 100, 4)}%` : `${Math.max(ratio * 100, active ? 2 : 0)}%`,
                  backgroundColor: barColor,
                }}
              />
            )}
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[9px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-secondary)' }}>
            <span>{task.phase === 'preparing' ? 'Packaging' : task.phase === 'transferring' ? 'Streaming bytes' : task.phase}</span>
            {determinate && <span>{task.totalIsEstimate ? 'Estimated total' : `${Math.round(ratio * 100)}%`}</span>}
          </div>
        </div>

        <div className="mx-5 mt-4 grid grid-cols-3 overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)' }}>
          <Metric
            label="已传输"
            value={task.total !== undefined
              ? `${formatBytes(task.loaded)} / ${task.totalIsEstimate ? '≈' : ''}${formatBytes(task.total)}`
              : formatBytes(task.loaded)}
          />
          <Metric label="当前速度" value={formatSpeed(task.speedBytesPerSecond)} divided />
          <Metric label="预计剩余" value={complete ? '已完成' : formatDuration(task.etaSeconds)} divided />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 border-t px-5 py-3.5" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg-primary) 45%, transparent)' }}>
          <div className="min-w-0 text-[10px] leading-4" style={{ color: failed ? 'var(--error)' : 'var(--text-secondary)' }}>
            {failed ? task.error : active ? '切换项目或 Session 不会中断此任务。' : complete ? '该状态将在几秒后自动关闭。' : '可以关闭此提示。'}
          </div>
          {active && (
            <button
              type="button"
              onClick={cancelExportTransfer}
              disabled={task.phase === 'cancelling'}
              className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                color: 'var(--error)',
                borderColor: 'color-mix(in srgb, var(--error) 42%, var(--border))',
                background: 'color-mix(in srgb, var(--error) 9%, var(--bg-tertiary))',
              }}
            >
              {task.phase === 'cancelling' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <OctagonX className="h-3.5 w-3.5" />}
              {task.phase === 'cancelling' ? '正在取消' : '取消传输'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, divided = false }: { label: string; value: string; divided?: boolean }) {
  return (
    <div className="min-w-0 px-3 py-3" style={{ borderLeft: divided ? '1px solid var(--border)' : undefined }}>
      <div className="text-[9px] font-medium uppercase tracking-[0.14em]" style={{ color: 'var(--text-secondary)' }}>{label}</div>
      <div className="mt-1 truncate font-mono text-[11px] font-semibold tabular-nums" title={value}>{value}</div>
    </div>
  );
}
