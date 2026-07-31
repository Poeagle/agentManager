import { fork, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import type { Readable } from 'stream';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface ArchiveReadyMessage {
  type: 'archive-ready';
  estimatedSize: number;
  sourceBytes: number;
  entryCount: number;
}

interface ArchiveErrorMessage {
  type: 'archive-error';
  message: string;
}

export interface DirectoryExportReady {
  stream: Readable;
  estimatedSize: number;
  sourceBytes: number;
  entryCount: number;
}

export interface DirectoryExportProcess {
  ready: Promise<DirectoryExportReady>;
  cancel: () => void;
}

const serviceDirectory = dirname(fileURLToPath(import.meta.url));
const compiledWorker = join(serviceDirectory, 'file-export-worker.js');
const sourceWorker = join(serviceDirectory, 'file-export-worker.ts');

function spawnExportWorker(directoryPath: string): ChildProcess {
  const compiled = existsSync(compiledWorker);
  return fork(compiled ? compiledWorker : sourceWorker, [directoryPath], {
    execArgv: compiled ? [] : ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
}

export function createDirectoryExport(directoryPath: string): DirectoryExportProcess {
  const child = spawnExportWorker(directoryPath);
  let readySettled = false;
  let archiveReady = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const ready = new Promise<DirectoryExportReady>((resolve, reject) => {
    child.on('message', (message: ArchiveReadyMessage | ArchiveErrorMessage) => {
      if (message.type === 'archive-ready') {
        if (!child.stdout) {
          readySettled = true;
          reject(new Error('Export worker did not provide an output stream'));
          return;
        }
        readySettled = true;
        archiveReady = true;
        resolve({
          stream: child.stdout,
          estimatedSize: message.estimatedSize,
          sourceBytes: message.sourceBytes,
          entryCount: message.entryCount,
        });
      } else if (message.type === 'archive-error') {
        const error = new Error(message.message);
        if (!readySettled) {
          readySettled = true;
          reject(error);
        } else if (archiveReady) {
          child.stdout?.destroy(error);
        }
      }
    });
    child.once('error', (error) => {
      if (!readySettled) {
        readySettled = true;
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (!readySettled) {
        readySettled = true;
        reject(new Error(signal ? `Export worker stopped (${signal})` : `Export worker exited with code ${code ?? 1}`));
      } else if (archiveReady && (signal || code)) {
        child.stdout?.destroy(new Error(signal ? `Export worker stopped (${signal})` : `Export worker exited with code ${code}`));
      }
    });
  });

  const cancel = () => {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2_000);
    killTimer.unref();
  };

  return { ready, cancel };
}
