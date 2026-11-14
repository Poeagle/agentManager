import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,existsSync,unlinkSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {config} from '../../../config.js';

/** All fields are JSON encoded before CSV quoting: embedded newlines remain
 * physical single lines, so incomplete writes can never become valid rows. */
export function encodeCsv(columns:string[],rows:unknown[][]){
 const cell=(v:unknown)=>'"'+JSON.stringify(v??null).replaceAll('"','""')+'"';
 return columns.join(',')+'\n'+rows.map(row=>row.map(cell).join(',')+'\n').join('');
}
export function decodeCsv(text:string):unknown[][]{
 const lines=text.split('\n');if(lines.pop()!=='')throw Error('Incomplete CSV');lines.shift();
 return lines.map(line=>{const fields:string[]=[];let value='',quoted=false;
  for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){fields.push(value);value='';}else value+=c;}
  if(quoted)throw Error('Invalid CSV');fields.push(value);return fields.map(v=>JSON.parse(v));});
}
function atomic(path:string,text:string){
 const temp=path+'.'+randomUUID()+'.tmp';let fd:number|undefined;
 try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,text);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,path);const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
 finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
}
export type UsageCsvSnapshot={day:string;timezone:string;current:unknown[][];history:unknown[][];quota:unknown[][];observed?:unknown[][];checkpoint?:string|null;source?:string|null};
export function usageCsvDirectory(account:string){return join(dirname(config.dbPath),'usage-csv',createHash('sha256').update(account).digest('hex'));}
/** One atomic manifest switches all files together. Retain the prior generation
 * until a later successful publish; interrupted exports leave the old one valid. */
export function publishUsageCsv(account:string,snapshot:UsageCsvSnapshot){
 const root=usageCsvDirectory(account);mkdirSync(root,{recursive:true,mode:0o700});
 const contents={current:encodeCsv(['day','hour','cwd','model','tier','tokens','requests','session_id','provider'],snapshot.current),history:encodeCsv(['day','hour','cwd','model','tier','tokens','requests','session_id','provider'],snapshot.history),quota:encodeCsv(['at','used','reset_at','email'],snapshot.quota),observed:encodeCsv(['hour','quota'],snapshot.observed??[])};
 const digest=createHash('sha256').update(snapshot.day).update(snapshot.timezone).update(snapshot.checkpoint??'').update(snapshot.source??'').update(JSON.stringify(contents)).digest('hex');
 const manifest=join(root,'manifest.json');let old:any;try{old=JSON.parse(readFileSync(manifest,'utf8'));}catch{}
 if(old?.digest===digest){try{readUsageCsv(account);return;}catch{/* Republish damaged generation from verified input. */}}
 let previous:any;try{previous=JSON.parse(readFileSync(join(root,'manifest.previous.json'),'utf8'));}catch{}
 if(old&&old.digest!==digest){try{readUsageCsv(account);atomic(join(root,'manifest.previous.json'),JSON.stringify(old));previous=old;}catch{}}
 const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const files={current:`current-${hash(contents.current)}.csv`,history:`hourly-${hash(contents.history)}.csv`,quota:`quota-${hash(contents.quota)}.csv`,observed:`observed-${hash(contents.observed)}.csv`};
 for(const key of ['current','history','quota','observed'] as const){const path=join(root,files[key]);if(!existsSync(path)||readFileSync(path,'utf8')!==contents[key])atomic(path,contents[key]);}
 atomic(manifest,JSON.stringify({version:1,account,day:snapshot.day,timezone:snapshot.timezone,checkpoint:snapshot.checkpoint??null,source:snapshot.source??null,digest,files}));
 for(const file of readdirSync(root))if(/^(current|hourly|quota|observed)-[a-f0-9]{64}\.csv$/.test(file)&&!Object.values(files).includes(file)&&!Object.values(previous?.files??{}).includes(file)){try{unlinkSync(join(root,file));}catch{}}
}
export function readUsageCsv(account:string,previous=false):UsageCsvSnapshot|null{
 const root=usageCsvDirectory(account),path=join(root,previous?'manifest.previous.json':'manifest.json');if(!existsSync(path))return null;
 const manifest=JSON.parse(readFileSync(path,'utf8'));if(manifest.version!==1||manifest.account!==account)throw Error('Invalid usage manifest');
 const contents:Record<string,string>={};
 for(const kind of ['current','history','quota','observed']){const file=manifest.files[kind];if(typeof file!=='string'||!/^(current|hourly|quota|observed)-[a-f0-9]{64}\.csv$/.test(file))throw Error('Invalid usage file');contents[kind]=readFileSync(join(root,file),'utf8');}
 const digest=createHash('sha256').update(manifest.day).update(manifest.timezone).update(manifest.checkpoint??'').update(manifest.source??'').update(JSON.stringify(contents)).digest('hex');if(digest!==manifest.digest)throw Error('Usage CSV checksum mismatch');
 return {day:manifest.day,timezone:manifest.timezone,checkpoint:manifest.checkpoint??null,source:manifest.source??null,current:decodeCsv(contents.current),history:decodeCsv(contents.history),quota:decodeCsv(contents.quota),observed:decodeCsv(contents.observed)};
}
export function csvUsageBreakdown(account:string,checkpoint?:string|null,timezone?:string):Array<Record<string,any>>|null{
 let snapshot:UsageCsvSnapshot|null;try{snapshot=readUsageCsv(account);}catch{return null;}if(!snapshot||checkpoint!==undefined&&snapshot.checkpoint!==checkpoint||timezone!==undefined&&snapshot.timezone!==timezone)return null;
 return [...snapshot.history,...snapshot.current].map(([day,,cwd,model,tier,tokens,requests])=>({day:day as string,cwd:cwd as string,model:model as string|null,tier:tier as string|null,requests:requests as number,...tokens as Record<string,number|null>}));
}
export function csvHourlyEvents(account:string,checkpoint?:string|null,timezone?:string){
 let snapshot:UsageCsvSnapshot|null;try{snapshot=readUsageCsv(account);}catch{return null;}if(!snapshot||checkpoint!==undefined&&snapshot.checkpoint!==checkpoint||timezone!==undefined&&snapshot.timezone!==timezone)return null;
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:snapshot.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
 return [...snapshot.history,...snapshot.current].map(([day,at,cwd,model,tier,tokens,requests],i)=>{let hour:string|null=null;if(typeof at==='string'){const p=Object.fromEntries(formatter.formatToParts(new Date(at)).map(p=>[p.type,p.value]));hour=`${p.year}-${p.month}-${p.day}T${p.hour}:00:00${p.timeZoneName==='GMT'?'+00:00':p.timeZoneName.replace('GMT','')}`;}return {event_key:`csv:${i}`,day:day as string,hour,cwd:cwd as string,model:model as string|null,tier:tier as string|null,provider:null,tokens:JSON.stringify({...tokens as object,requests,_timezone:snapshot.timezone})};});
}
