export const MAX_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface FileUploadRequest {
  files: File[];
  containsDirectories: boolean;
  key: number;
}

export function isFileDrag(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files');
}

// Read the protected drag data during drop, before the browser clears it.
export function droppedFiles(transfer: DataTransfer) {
  return {
    files: Array.from(transfer.files),
    containsDirectories: Array.from(transfer.items ?? []).some(
      (item) => item.webkitGetAsEntry?.()?.isDirectory,
    ),
  };
}
