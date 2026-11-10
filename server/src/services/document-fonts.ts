import {execFile} from 'child_process';
import {promisify} from 'util';
import {homedir} from 'os';
import {isAbsolute,join,relative,sep} from 'path';
import {realpath,stat} from 'fs/promises';
import {unzipSync} from 'fflate';
const run=promisify(execFile);
export interface PreviewFontReport {
 checked:boolean;
 substitutions:Array<{requested:string;replacement:string}>;
 omitted?:number
}
const unescapeXml=(s:string)=>s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi,v=>{
 const code=v.startsWith('&#x')?parseInt(v.slice(3,-1),16):v.startsWith('&#')?parseInt(v.slice(2,-1),10):null;
 return code!==null&&code>0&&code<=0x10ffff?String.fromCodePoint(code):({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[v]||v);
});
const attrs=(s:string)=>Object.fromEntries([...s.matchAll(/(?:[\w.-]+:)?([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1],unescapeXml(m[2])]));
const normalize=(s:string)=>s.toLowerCase().replace(/[\s_-]/g,'');
const escapeXml=(s:string)=>s.replace(/[&<>"']/g,v=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[v]!));

/** Inspect bounded DOCX text/style parts; never inflate media or execute XML. */
export function requestedDocumentFonts(content:Buffer,extension:string):{fonts:string[];checked:boolean}{
 if(extension!=='docx')return {fonts:[],checked:false};
 let checked=true,total=0;const fonts=new Set<string>();
 try{
  const files=unzipSync(content,{filter:file=>{
   if(!/^word\/(?:document|styles|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(file.name))return false;
   if(file.originalSize>4*1024*1024||total+file.originalSize>16*1024*1024){checked=false;return false;}total+=file.originalSize;return true;
  }});
  const decoder=new TextDecoder(),parts=Object.entries(files).filter(([name])=>!name.endsWith('/styles.xml')).map(([,bytes])=>decoder.decode(bytes));
  if(!files['word/document.xml'])checked=false;
  const needed=new Set<string>(),styles=new Map<string,{text:string;base?:string}>();
  for(const part of parts)for(const m of part.matchAll(/<(?:[\w.-]+:)?(?:pStyle|rStyle)\b([^>]*)\/?\s*>/g)){const a=attrs(m[1]);if(a.val)needed.add(a.val);}
  const xml=files['word/styles.xml']?decoder.decode(files['word/styles.xml']):'';
  for(const m of xml.matchAll(/<(?:[\w.-]+:)?style\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?style>/g)){
   const a=attrs(m[1]),base=/<(?:[\w.-]+:)?basedOn\b([^>]*)/.exec(m[2]);
   if(a.styleId)styles.set(a.styleId,{text:m[2],base:base?attrs(base[1]).val:undefined});
   if(a.default==='1'||a.default==='true')needed.add(a.styleId);
  }
  const defaults=/<(?:[\w.-]+:)?docDefaults\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?docDefaults>/.exec(xml);if(defaults)parts.push(defaults[1]);
  const seen=new Set<string>();for(const id of needed){let key:string|undefined=id;while(key&&!seen.has(key)){seen.add(key);const style=styles.get(key);if(!style){checked=false;break;}parts.push(style.text);key=style.base;}}
  for(const part of parts)for(const m of part.matchAll(/<(?:[\w.-]+:)?rFonts\b([^>]*)\/?\s*>/g)){
   const a=attrs(m[1]);for(const key of ['ascii','hAnsi','eastAsia','cs'])if(a[key]){if(a[key].length<=120)fonts.add(a[key]);else checked=false;}
   if(['ascii','hAnsi','eastAsia','cs'].some(key=>a[key+'Theme']&&!a[key]))checked=false;
  }
 }catch{checked=false;}
 if(fonts.size>32)checked=false;
 return {fonts:[...fonts].slice(0,32),checked:checked&&fonts.size>0};
}

/** Export only installed font files, not their home directories or settings. */
export async function documentFontEnvironment(content:Buffer,extension:string){
 const requested=requestedDocumentFonts(content,extension),report:PreviewFontReport={checked:requested.checked,substitutions:[]};
 const files:string[]=[];let config='';
 try{
  const {stdout}=await run('/usr/bin/fc-list',['-f','%{family}\t%{file}\n'],{timeout:5000,maxBuffer:2*1024*1024});
  const inventory=stdout.split('\n').flatMap(line=>{const [family,path]=line.split('\t');return family&&path?[{names:family.split(',').map(normalize),path}]:[];});
  const roots=[join(homedir(),'.local/share/fonts'),join(homedir(),'.fonts'),...(process.env.XDG_DATA_HOME?[join(process.env.XDG_DATA_HOME,'fonts')]:[])];
  let total=0;for(const font of inventory){
   if(!/\.(?:otf|ttf|ttc)$/i.test(font.path)||!roots.some(root=>{const child=relative(root,font.path);return child&&!isAbsolute(child)&&child!=='..'&&!child.startsWith('..'+sep);}))continue;
   const path=await realpath(font.path),info=await stat(path);if(!info.isFile()||info.size>64*1024*1024||files.includes(path))continue;
   if(files.length>=128||total+info.size>256*1024*1024){report.checked=false;continue;}files.push(path);total+=info.size;
  }
  const aliases:Array<[string,string]>=[];
  for(const family of requested.fonts){
   if(inventory.some(font=>font.names.includes(normalize(family))))continue;
   const fang=/^(?:仿宋|fangsong)(?:[_ -]?gb2312)?$/i.test(family)&&inventory.some(font=>font.names.includes(normalize('FandolFang')));
   const replacement=fang?'FandolFang':(await run('/usr/bin/fc-match',['-f','%{family[0]}','--',family.replace(/([\\,:-])/g,'\\$1')],{timeout:3000,maxBuffer:4096})).stdout.trim();
   if(replacement){report.substitutions.push({requested:family,replacement});aliases.push([family,replacement]);}else report.checked=false;
  }
  if(!requested.checked&&inventory.some(font=>font.names.includes(normalize('FandolFang'))))for(const family of ['仿宋','FangSong','仿宋_GB2312','FangSong_GB2312'])if(!aliases.some(([name])=>name===family))aliases.push([family,'FandolFang']);
  config=aliases.map(([from,to])=>`<alias binding="strong"><family>${escapeXml(from)}</family><prefer><family>${escapeXml(to)}</family></prefer></alias>`).join('');
 }catch{report.checked=false;}
 return {files,report,config:`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>/work/fonts</dir><cachedir>/work/font-cache</cachedir>${config}</fontconfig>`};
}
