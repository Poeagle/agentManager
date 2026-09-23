// Explorer paths are absolute server paths, not browser URLs.
export function normalizeExplorerPath(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return null;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return '/' + segments.join('/');
}

export function isWithinExplorerRoot(path: string, root: string): boolean {
  const normalized = normalizeExplorerPath(path);
  const normalizedRoot = normalizeExplorerPath(root);
  return normalized !== null && normalizedRoot !== null
    && (normalized === normalizedRoot || normalized.startsWith(normalizedRoot === '/' ? '/' : normalizedRoot + '/'));
}
