interface WritableFileHandleLike {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface FileHandleLike {
  name?: string;
  createWritable(): Promise<WritableFileHandleLike>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileHandleLike>;
}

export type LocalExportResult =
  | { kind: 'saved'; fileName: string }
  | { kind: 'download'; fileName: string }
  | { kind: 'cancelled'; fileName: string };

export interface LocalExportProgress {
  loaded: number;
  total?: number;
  totalIsEstimate?: boolean;
}

interface LocalExportOptions {
  browserWindow?: SaveFilePickerWindow;
  browserDocument?: Document;
  onProgress?: (progress: LocalExportProgress) => void;
  signal?: AbortSignal;
}

type ExportPayload = Blob | Response;

export function localExportFileName(name: string, isDirectory: boolean) {
  return isDirectory ? `${name}.zip` : name;
}

function isResponse(payload: ExportPayload): payload is Response {
  return typeof Response !== 'undefined' && payload instanceof Response;
}

function responseSize(response: Response): { total?: number; estimated: boolean } {
  const header = response.headers.get('Content-Length');
  if (header !== null) {
    const value = Number(header);
    if (Number.isFinite(value) && value >= 0) return { total: value, estimated: false };
  }
  const estimateHeader = response.headers.get('X-Export-Estimated-Size');
  if (estimateHeader !== null) {
    const value = Number(estimateHeader);
    if (Number.isFinite(value) && value > 0) return { total: value, estimated: true };
  }
  return { estimated: false };
}

async function abortWritable(writable: WritableFileHandleLike) {
  await writable.abort?.().catch(() => undefined);
}

async function writePayload(
  payload: ExportPayload,
  writable: WritableFileHandleLike,
  onProgress?: (progress: LocalExportProgress) => void,
  signal?: AbortSignal,
) {
  if (isResponse(payload) && payload.body) {
    const { total, estimated } = responseSize(payload);
    const reader = payload.body.getReader();
    let loaded = 0;
    let lastReport = 0;
    const report = () => onProgress?.({ loaded, total, totalIsEstimate: estimated });
    const cancelReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener('abort', cancelReader, { once: true });
    report();
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          signal?.throwIfAborted();
          break;
        }
        await writable.write(value);
        signal?.throwIfAborted();
        loaded += value.byteLength;
        const now = Date.now();
        if (now - lastReport >= 100) {
          report();
          lastReport = now;
        }
      }
      report();
      await writable.close();
      return;
    } catch (error) {
      await abortWritable(writable);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
  }

  const blob = isResponse(payload) ? await payload.blob() : payload;
  onProgress?.({ loaded: 0, total: blob.size });
  const cancelWrite = () => { void abortWritable(writable); };
  signal?.addEventListener('abort', cancelWrite, { once: true });
  try {
    signal?.throwIfAborted();
    await writable.write(blob);
    signal?.throwIfAborted();
    onProgress?.({ loaded: blob.size, total: blob.size });
    await writable.close();
  } catch (error) {
    await abortWritable(writable);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancelWrite);
  }
}

async function payloadBlob(payload: ExportPayload) {
  return isResponse(payload) ? payload.blob() : payload;
}

/**
 * Open the save picker before starting the network request so the browser's
 * transient user activation is still valid. Granting access to one file also
 * avoids the sensitive-directory warning raised by directory-wide access.
 * Browsers without the File System Access API use their normal download flow.
 */
export async function exportBlobToLocalFolder(
  loadPayload: () => Promise<ExportPayload>,
  requestedName: string,
  options: LocalExportOptions = {},
): Promise<LocalExportResult> {
  const browserWindow = options.browserWindow ?? (window as SaveFilePickerWindow);
  const browserDocument = options.browserDocument ?? document;
  const picker = browserWindow.showSaveFilePicker;
  if (picker) {
    let fileHandle: FileHandleLike;
    try {
      fileHandle = await picker.call(browserWindow, { suggestedName: requestedName });
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        return { kind: 'cancelled', fileName: requestedName };
      }
      throw error;
    }

    options.signal?.throwIfAborted();
    const payload = await loadPayload();
    options.signal?.throwIfAborted();
    const writable = await fileHandle.createWritable();
    await writePayload(payload, writable, options.onProgress, options.signal);
    return { kind: 'saved', fileName: fileHandle.name || requestedName };
  }

  options.signal?.throwIfAborted();
  const blob = await payloadBlob(await loadPayload());
  options.signal?.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = browserDocument.createElement('a');
  anchor.href = objectUrl;
  anchor.download = requestedName;
  anchor.style.display = 'none';
  browserDocument.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return { kind: 'download', fileName: requestedName };
}
