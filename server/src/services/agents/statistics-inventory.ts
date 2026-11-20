import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Enumerate trusted Agent roots once per collection pass. Reuse the same
 * scanner for open native files and files with no platform tab. */
export async function* statisticsFiles(root: string, maxDepth: number): AsyncGenerator<string> {
  const source = await lstat(root).catch(() => null);
  if (!source?.isDirectory() || source.isSymbolicLink()) return;
  let count = 0;
  async function* visit(directory: string, depth: number): AsyncGenerator<string> {
    const entries = await readdir(directory, {withFileTypes:true}).catch(() => []);
    for (const entry of entries) {
      if (++count > 40_000) return;
      if (entry.isSymbolicLink() || entry.name === '.agentmanager-imports') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < maxDepth) yield* visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
    }
  }
  yield* visit(root, 0);
}
