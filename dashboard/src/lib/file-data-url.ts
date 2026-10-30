export function readFileAsDataUrl(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => reader.abort();
    signal.addEventListener('abort', abort, { once: true });
    reader.onload = () => { cleanup(); resolve(reader.result as string); };
    reader.onerror = () => { cleanup(); reject(reader.error || new Error('Failed to read file')); };
    reader.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    reader.readAsDataURL(file);
  });
}
