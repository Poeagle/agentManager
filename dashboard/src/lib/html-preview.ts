import {isWithinExplorerRoot,normalizeExplorerPath} from './explorer-path';
import type {api} from './api';
const fontTypes=new Set(['woff','woff2','ttf','otf']);
const textTypes=new Set(['css','js','mjs','json','html','htm','xhtml']);
const imageTypes=new Set(['png','jpg','jpeg','gif','svg','webp','bmp','ico','avif']);
/** Bundle only referenced project assets into opaque Blob URLs. No project web
 * server is started and the iframe receives no platform credentials. */
export async function buildHtmlPreview(content:string,path:string,root:string,files:typeof api.files,signal:AbortSignal){
 const urls:string[]=[],warnings=new Set<string>(),cache=new Map<string,Promise<string>>();let bytes=content.length,count=0;
 const resolve=(source:string,base:string)=>{
  if(!source||source.startsWith('#')||/^(?:data:|blob:)/i.test(source))return null;
  if(/^[a-z][a-z\d+.-]*:|^\/\//i.test(source)){warnings.add('外部资源');return null;}
  try{const clean=decodeURIComponent(source.split(/[?#]/)[0]);const candidate=normalizeExplorerPath(clean.startsWith(root+'/')?clean:clean.startsWith('/')?`${root}/${clean}`:`${base.slice(0,base.lastIndexOf('/'))}/${clean}`);return candidate&&isWithinExplorerRoot(candidate,root)?candidate:null;}catch{return null;}
 };
 const dataUrl=(value:Blob)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('资源读取失败'));reader.readAsDataURL(value);});
 const blob=(body:BlobPart,type:string)=>dataUrl(new Blob([body],{type}));
 const replaceAsync=async(text:string,regex:RegExp,replace:(match:RegExpExecArray)=>Promise<string>)=>{const matches=[...text.matchAll(regex)];const values=await Promise.all(matches.map(match=>replace(match)));let result='',last=0;for(let i=0;i<matches.length;i++){const match=matches[i];result+=text.slice(last,match.index)+values[i];last=match.index!+match[0].length;}return result+text.slice(last);};
 const css=async(text:string,base:string,depth:number,ancestors=new Set<string>()):Promise<string>=>{
  const imported=await replaceAsync(text,/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/gi,async m=>{const next=await asset(m[1],base,depth+1,ancestors);return next?`@import url("${next}");`:'';});
  return replaceAsync(imported,/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,async m=>{if(/^(?:data:|blob:|#)/i.test(m[2]))return m[0];const next=await asset(m[2],base,depth+1,ancestors);return `url("${next||''}")`;});
 };
 const javascript=async(text:string,base:string,depth:number,ancestors=new Set<string>())=>{
  const modules=await replaceAsync(text,/(\b(?:import|export)\s+(?:(?:[^"'\n]+?\s+from\s*)|(?:\(\s*))?)["']([^"']+)["']/g,async m=>{const next=await asset(m[2],base,depth+1,ancestors);return next?`${m[1]}"${next}"`:m[0];});
  return replaceAsync(modules,/(\bfetch\(\s*)["']([^"']+)["']/g,async m=>{const next=await asset(m[2],base,depth+1,ancestors);return next?`${m[1]}"${next}"`:m[0];});
 };
 const asset=async(source:string,base:string,depth=0,ancestors=new Set<string>()):Promise<string>=>{
  if(/^(?:data:|blob:)/i.test(source))return source;
  const target=resolve(source,base);if(!target)return '';
  const ext=target.split('.').pop()!.toLowerCase();if(!textTypes.has(ext)&&!imageTypes.has(ext)&&!fontTypes.has(ext)){warnings.add('暂不支持的资源');return '';}
  // Cyclic imports remain blocked rather than recursively fetching forever.
  if(depth>5){warnings.add('资源引用过深');return '';}
  if(ancestors.has(target)){warnings.add('循环资源引用');return '';}
  const existing=cache.get(target);if(existing)return existing;
  const nextAncestors=new Set([...ancestors,target]);
  if(++count>64){warnings.add('资源数量过多');return '';}
  const promise=(async()=>{
   try{
    signal.throwIfAborted();
    if(imageTypes.has(ext)||fontTypes.has(ext)){const data=await files.preview(target,signal);bytes+=data.size;if(bytes>20*1024*1024)throw Error('资源总量超过 20 MB');if(fontTypes.has(ext))return dataUrl(data);const url=URL.createObjectURL(data);urls.push(url);return url;}
    const result=await files.read(target);signal.throwIfAborted();bytes+=result.content.length;if(bytes>20*1024*1024)throw Error('资源总量超过 20 MB');
    let data=result.content;
    if(ext==='css')data=await css(data,target,depth,nextAncestors);
    if(ext==='js'||ext==='mjs')data=await javascript(data,target,depth,nextAncestors);
    return blob(data,ext==='css'?'text/css':ext==='js'||ext==='mjs'?'text/javascript':ext==='json'?'application/json':'text/plain');
   }catch(error){if(signal.aborted)throw error;warnings.add(`资源未加载：${target.split('/').pop()}`);return '';}
  })();cache.set(target,promise);return promise;
 };
 try{
  const doc=new DOMParser().parseFromString(content,'text/html');
  if(doc.querySelector('iframe,object,embed'))warnings.add('嵌入页面');
  doc.querySelectorAll('base,meta[http-equiv],iframe,object,embed').forEach(node=>node.remove());
  for(const node of doc.querySelectorAll<HTMLImageElement|HTMLScriptElement|HTMLLinkElement|HTMLSourceElement>('img[src],script[src],link[href],source[src]')){
   const attribute=node.tagName==='LINK'?'href':'src',source=node.getAttribute(attribute)!;
   if(node.tagName==='LINK'&&!['stylesheet','icon','shortcut icon'].includes((node.getAttribute('rel')||'').toLowerCase())){node.remove();continue;}
   const url=await asset(source,path);if(url){node.setAttribute(attribute,url);node.removeAttribute('integrity');node.removeAttribute('crossorigin');}else node.removeAttribute(attribute);
  }
  for(const node of doc.querySelectorAll<HTMLImageElement>('img[srcset],source[srcset]')){node.removeAttribute('srcset');}
  for(const node of doc.querySelectorAll<HTMLElement>('[style]'))node.setAttribute('style',await css(node.getAttribute('style')||'',path,0));
  for(const node of doc.querySelectorAll('style'))node.textContent=await css(node.textContent||'',path,0);
  for(const node of doc.querySelectorAll('script:not([src])'))if(['','module','text/javascript','application/javascript'].includes(node.getAttribute('type')||''))node.textContent=await javascript(node.textContent||'',path,0);
  const csp=doc.createElement('meta');csp.httpEquiv='Content-Security-Policy';csp.content="default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src blob: data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";doc.head.prepend(csp);
  if(!doc.querySelector('meta[name=viewport]')){const viewport=doc.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';doc.head.append(viewport);}
  const navigation=doc.createElement('script');navigation.textContent=`window.addEventListener('error',function(e){parent.postMessage({type:'octoally-preview-error',message:e.message||'页面脚本出错'},'*');});window.addEventListener('unhandledrejection',function(e){parent.postMessage({type:'octoally-preview-error',message:String(e.reason&&e.reason.message||e.reason||'资源加载失败')},'*');});document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a)return;var href=a.getAttribute('href')||'';if(href.charAt(0)==='#')return;e.preventDefault();parent.postMessage({type:'octoally-preview-link',href:href},'*');},true);`;doc.head.insertBefore(navigation,csp.nextSibling);
  return {html:'<!doctype html>'+doc.documentElement.outerHTML,warnings:[...warnings],dispose:()=>urls.forEach(url=>URL.revokeObjectURL(url))};
 }catch(error){urls.forEach(url=>URL.revokeObjectURL(url));throw error;}
}
