import { openSync, readSync, closeSync } from 'fs';
export function readFilePrefix(path: string, maxBytes = 512 * 1024): string {
    let fd: number | null = null;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.allocUnsafe(maxBytes);
        const bytes = readSync(fd, buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytes).toString('utf8');
    }
    catch {
        return '';
    }
    finally {
        if (fd !== null)
            try {
                closeSync(fd);
            }
            catch { /* ignore */ }
    }
}
