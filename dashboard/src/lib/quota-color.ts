/** Remaining quota: healthy green through warning amber to critical red. */
export function quotaColor(remaining:number):string {
  if(remaining<=10)return 'var(--error)';
  if(remaining<=25)return '#e57b18';
  if(remaining<60)return '#b7790b';
  return 'var(--success)';
}
