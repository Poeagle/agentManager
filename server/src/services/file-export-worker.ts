/**
 * Directory ZIP worker.
 *
 * ZIP compression is deliberately isolated in this child process. fflate's
 * streaming deflate is synchronous, so running it inside Fastify can delay
 * unrelated API requests while a large project is being exported.
 */
import { createReadStream } from 'fs';
import { lstat, readdir } from 'fs/promises';
import { basename, join } from 'path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

interface ArchiveEntry {
  diskPath: string;
  archivePath: string;
  directory: boolean;
  size: number;
}

async function scanDirectory(directoryPath: string) {
  const rootName = basename(directoryPath) || 'export';
  const entries: ArchiveEntry[] = [{
    diskPath: directoryPath,
    archivePath: rootName,
    directory: true,
    size: 0,
  }];
  let sourceBytes = 0;

  const scan = async (diskPath: string, archivePath: string): Promise<void> => {
    const children = await readdir(diskPath, { withFileTypes: true });
    for (const child of children) {
      const childDiskPath = join(diskPath, child.name);
      const childArchivePath = `${archivePath}/${child.name}`;
      if (child.isDirectory()) {
        entries.push({ diskPath: childDiskPath, archivePath: childArchivePath, directory: true, size: 0 });
        await scan(childDiskPath, childArchivePath);
      } else if (child.isFile()) {
        const stats = await lstat(childDiskPath);
        entries.push({ diskPath: childDiskPath, archivePath: childArchivePath, directory: false, size: stats.size });
        sourceBytes += stats.size;
      }
      // Symlinks and special files stay excluded so the archive cannot escape
      // the selected project or block on a device/FIFO.
    }
  };

  await scan(directoryPath, rootName);
  return { entries, sourceBytes };
}

async function writeArchive(entries: ArchiveEntry[]) {
  let drainPromise: Promise<void> | null = null;
  let resolveDrain: (() => void) | null = null;

  const waitForDrain = () => drainPromise ?? Promise.resolve();
  const writeOutput = (data: Uint8Array) => {
    if (!data.length || process.stdout.write(Buffer.from(data))) return;
    if (!drainPromise) {
      drainPromise = new Promise<void>((resolve) => { resolveDrain = resolve; });
      process.stdout.once('drain', () => {
        const resolve = resolveDrain;
        resolveDrain = null;
        drainPromise = null;
        resolve?.();
      });
    }
  };

  let resolveFinal: (() => void) | null = null;
  let rejectFinal: ((error: Error) => void) | null = null;
  const completed = new Promise<void>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  const archive = new Zip((error, data, final) => {
    if (error) {
      rejectFinal?.(error);
      return;
    }
    writeOutput(data);
    if (final) resolveFinal?.();
  });

  for (const entry of entries) {
    await waitForDrain();
    if (entry.directory) {
      const directoryEntry = new ZipPassThrough(`${entry.archivePath}/`);
      archive.add(directoryEntry);
      directoryEntry.push(new Uint8Array(), true);
      continue;
    }

    const fileEntry = new ZipDeflate(entry.archivePath, { level: 6 });
    archive.add(fileEntry);
    for await (const chunk of createReadStream(entry.diskPath)) {
      fileEntry.push(chunk as Buffer, false);
      await waitForDrain();
    }
    fileEntry.push(new Uint8Array(), true);
  }

  archive.end();
  await completed;
  await waitForDrain();
}

async function main() {
  const directoryPath = process.argv[2];
  if (!directoryPath) throw new Error('Missing export directory');
  const { entries, sourceBytes } = await scanDirectory(directoryPath);
  process.send?.({
    type: 'archive-ready',
    sourceBytes,
    entryCount: entries.length,
    // ZIP metadata adds a small amount around each entry. Compression usually
    // makes the final archive smaller, so this is explicitly an estimate.
    estimatedSize: Math.max(256, sourceBytes + entries.length * 128),
  });
  await writeArchive(entries);
}

void main()
  .then(() => process.stdout.end())
  .catch((error: unknown) => {
    process.send?.({
      type: 'archive-error',
      message: error instanceof Error ? error.message : 'Failed to create ZIP archive',
    });
    process.exitCode = 1;
    process.stdout.destroy();
  });
