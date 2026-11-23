import { createWriteStream } from 'node:fs';
import { link, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyContentTypeParser } from 'fastify';

export const MAX_FILE_UPLOAD_MB = 500;
export const MAX_FILE_UPLOAD_BYTES = MAX_FILE_UPLOAD_MB * 1024 * 1024;

export class BinaryUploadError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const tooLarge = () => new BinaryUploadError(413, `单个文件最多 ${MAX_FILE_UPLOAD_MB} MB`);

export const binaryUploadParser: FastifyContentTypeParser = (request, stream, done) => {
  if (!/\/(?:files\/upload|sessions\/:id\/paste-file)$/.test(request.routeOptions.url ?? '')) {
    return done(new BinaryUploadError(415, 'Expected JSON content'));
  }
  done(null, stream);
};

export function binaryUploadLength(header: string | undefined): number | undefined {
  if (header === undefined) return;
  if (!/^\d+$/.test(header)) throw new BinaryUploadError(400, 'Invalid Content-Length');
  const size = Number(header);
  if (size > MAX_FILE_UPLOAD_BYTES) throw tooLarge();
  return size;
}

export async function saveBinaryUpload(source: Readable, target: string, expected: number | undefined, mode: number): Promise<number> {
  const staging = await mkdtemp(join(dirname(target), '.upload-'));
  const temporary = join(staging, 'content');
  let size = 0;
  try {
    await pipeline(async function* () {
      // A size error must leave the HTTP response socket open to return 413.
      for await (const chunk of source.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_FILE_UPLOAD_BYTES) throw tooLarge();
        yield chunk;
      }
      if (expected !== undefined && size !== expected) throw new BinaryUploadError(400, 'File upload was incomplete');
    }, createWriteStream(temporary, { flags: 'wx', mode }));
    // A hard link publishes the completed file atomically without overwriting
    // an existing file, directory or symlink, including a concurrent upload.
    await link(temporary, target);
    return size;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
