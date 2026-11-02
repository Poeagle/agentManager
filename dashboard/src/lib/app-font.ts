export const DEFAULT_APP_FONT='Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const APP_FONT_OPTIONS=[
  {id:'system',label:'系统默认',family:''},
  {id:'yahei',label:'微软雅黑',family:'Microsoft YaHei'},
  {id:'pingfang',label:'苹方',family:'PingFang SC'},
  {id:'source-han',label:'思源黑体',family:'Source Han Sans SC'},
  {id:'noto',label:'Noto Sans CJK',family:'Noto Sans CJK SC'},
  {id:'wenkai',label:'霞鹜文楷',family:'LXGW WenKai'},
  {id:'arial',label:'Arial',family:'Arial'},
] as const;

export function validAppFont(value:string):boolean {
  return /^[\p{L}\p{N} _.-]{0,100}$/u.test(value);
}
export function appFontStack(value:string|null|undefined):string {
  const name=value?.trim()||'';
  return name&&validAppFont(name)?`"${name}", ${DEFAULT_APP_FONT}`:DEFAULT_APP_FONT;
}
export function applyAppFont(value:string|null|undefined):void {
  document.documentElement.style.setProperty('--app-font-family',appFontStack(value));
}
