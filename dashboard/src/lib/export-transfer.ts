import { create } from 'zustand';
import { api } from './api';
import {
  exportBlobToLocalFolder,
  localExportFileName,
  type LocalExportProgress,
} from './file-export';

export type ExportTransferPhase =
  | 'choosing'
  | 'preparing'
  | 'transferring'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface ExportTransferTask {
  id: string;
  sourcePath: string;
  fileName: string;
  isDirectory: boolean;
  phase: ExportTransferPhase;
  loaded: number;
  total?: number;
  totalIsEstimate: boolean;
  speedBytesPerSecond: number;
  etaSeconds?: number;
  startedAt: number;
  error?: string;
}

interface ExportTransferState {
  task: ExportTransferTask | null;
}

interface StartExportTransferInput {
  path: string;
  name: string;
  isDirectory: boolean;
}

const ACTIVE_PHASES = new Set<ExportTransferPhase>([
  'choosing',
  'preparing',
  'transferring',
  'cancelling',
]);

export const useExportTransferStore = create<ExportTransferState>(() => ({ task: null }));

let activeController: AbortController | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function clearDismissTimer() {
  if (!dismissTimer) return;
  clearTimeout(dismissTimer);
  dismissTimer = null;
}

function updateTask(id: string, update: Partial<ExportTransferTask>) {
  const current = useExportTransferStore.getState().task;
  if (!current || current.id !== id) return;
  useExportTransferStore.setState({ task: { ...current, ...update } });
}

function scheduleDismiss(id: string, delay: number) {
  clearDismissTimer();
  dismissTimer = setTimeout(() => {
    const current = useExportTransferStore.getState().task;
    if (current?.id === id && !ACTIVE_PHASES.has(current.phase)) {
      useExportTransferStore.setState({ task: null });
    }
    dismissTimer = null;
  }, delay);
}

function isAbortError(error: unknown) {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

export function isExportTransferActive(task: ExportTransferTask | null) {
  return !!task && ACTIVE_PHASES.has(task.phase);
}

export function dismissExportTransfer() {
  const task = useExportTransferStore.getState().task;
  if (!task || isExportTransferActive(task)) return;
  clearDismissTimer();
  useExportTransferStore.setState({ task: null });
}

export function cancelExportTransfer() {
  const task = useExportTransferStore.getState().task;
  if (!task || !isExportTransferActive(task) || task.phase === 'cancelling') return;
  updateTask(task.id, { phase: 'cancelling', etaSeconds: undefined });
  activeController?.abort(new DOMException('Export cancelled', 'AbortError'));
}

export async function startExportTransfer(input: StartExportTransferInput) {
  const existing = useExportTransferStore.getState().task;
  if (isExportTransferActive(existing)) return false;

  clearDismissTimer();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fileName = localExportFileName(input.name, input.isDirectory);
  const controller = new AbortController();
  activeController = controller;
  const startedAt = Date.now();
  const samples: Array<{ at: number; loaded: number }> = [];

  useExportTransferStore.setState({
    task: {
      id,
      sourcePath: input.path,
      fileName,
      isDirectory: input.isDirectory,
      phase: 'choosing',
      loaded: 0,
      totalIsEstimate: false,
      speedBytesPerSecond: 0,
      startedAt,
    },
  });

  const handleProgress = (progress: LocalExportProgress) => {
    const now = Date.now();
    samples.push({ at: now, loaded: progress.loaded });
    while (samples.length > 2 && samples[0].at < now - 5_000) samples.shift();

    const first = samples[0];
    const elapsedSeconds = Math.max((now - first.at) / 1000, 0.001);
    const windowBytes = Math.max(0, progress.loaded - first.loaded);
    const speedBytesPerSecond = samples.length > 1 ? windowBytes / elapsedSeconds : 0;
    const remainingBytes = progress.total === undefined
      ? undefined
      : Math.max(0, progress.total - progress.loaded);
    const etaSeconds = remainingBytes !== undefined && speedBytesPerSecond > 0
      ? remainingBytes / speedBytesPerSecond
      : undefined;

    updateTask(id, {
      phase: 'transferring',
      loaded: progress.loaded,
      total: progress.total,
      totalIsEstimate: !!progress.totalIsEstimate,
      speedBytesPerSecond,
      etaSeconds,
    });
  };

  try {
    updateTask(id, { phase: 'preparing' });
    const result = await exportBlobToLocalFolder(
      () => api.files.export(input.path, controller.signal),
      fileName,
      { signal: controller.signal, onProgress: handleProgress },
    );

    if (result.kind === 'cancelled') {
      updateTask(id, { phase: 'cancelled', etaSeconds: undefined });
      scheduleDismiss(id, 1_800);
    } else {
      updateTask(id, {
        phase: 'completed',
        fileName: result.fileName,
        etaSeconds: 0,
        speedBytesPerSecond: 0,
      });
      scheduleDismiss(id, 4_000);
    }
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      updateTask(id, { phase: 'cancelled', etaSeconds: undefined, speedBytesPerSecond: 0 });
      scheduleDismiss(id, 2_500);
    } else {
      updateTask(id, {
        phase: 'error',
        error: error instanceof Error && error.message ? error.message : 'Failed to export item',
        etaSeconds: undefined,
        speedBytesPerSecond: 0,
      });
    }
  } finally {
    if (activeController === controller) activeController = null;
  }

  return true;
}
