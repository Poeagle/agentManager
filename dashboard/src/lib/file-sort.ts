import type { FileEntry } from './api';
export type FileSort = 'name' | 'modified_desc' | 'modified_asc';
const collator = new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
export function compareFileEntries(a: FileEntry,b: FileEntry,order:FileSort):number {
  if (a.type!==b.type) return a.type==='directory' ? -1 : 1;
  if (order!=='name') {
    const left=Date.parse(a.modified_at || ''); const right=Date.parse(b.modified_at || '');
    if (Number.isFinite(left) && Number.isFinite(right) && left!==right) return (left-right)*(order==='modified_desc' ? -1 : 1);
    if (Number.isFinite(left)!==Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
  }
  return collator.compare(a.name,b.name);
}
