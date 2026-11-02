/** User-Agent is client-reported; do not infer a device name or location. */
export function loginDevice(agent:string|null|undefined):string {
  if(!agent)return '未记录';
  const browser=/Edg\//.test(agent)?'Edge':/Firefox\//.test(agent)?'Firefox':/(Chrome|CriOS)\//.test(agent)?'Chrome':/Safari\//.test(agent)?'Safari':null;
  const os=/Android/.test(agent)?'Android':/(iPhone|iPad)/.test(agent)?'iOS':/Windows/.test(agent)?'Windows':/Macintosh|Mac OS X/.test(agent)?'macOS':/Linux/.test(agent)?'Linux':null;
  return [browser,os].filter(Boolean).join(' · ')||'其他客户端';
}
