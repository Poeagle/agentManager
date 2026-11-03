import { realpathSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { config } from '../../config.js';
import { getDb } from '../../db/index.js';

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch { const parent = dirname(absolute); return parent === absolute ? absolute : join(canonical(parent), absolute.slice(parent.length + (parent === '/' ? 0 : 1))); }
}

/** Resource configuration is managed only by the owner-scoped API. Generic
 * file reads/exports must never provide an alternate route to the keyring. */
export function privateResourcePath(path: string, includeAncestors = false): boolean {
  const targets = [resolve(path), canonical(path)];
  const keyring = canonical(join(dirname(resolve(config.dbPath)), 'shared-resource-keys'));
  const files = (getDb().prepare("SELECT env_file FROM user_shared_resources WHERE env_file <> ''").all() as Array<{env_file:string}>).map(row=>canonical(row.env_file));
  return targets.some(target => target.split(sep).includes('.octoally-shared')
    || target === keyring || target.startsWith(keyring + sep)
    || files.some(file=>target===file || includeAncestors && file.startsWith(target+sep))
    || includeAncestors && (keyring.startsWith(target + sep) || target === '/'));
}
