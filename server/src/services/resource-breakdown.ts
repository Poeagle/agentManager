import {execFile} from 'child_process';
import {readFile,realpath,stat} from 'fs/promises';
import {relative,isAbsolute,resolve} from 'path';
import {cpus} from 'os';
import {promisify} from 'util';
import {serverResourceSampler} from './server-resources.js';

const exec=promisify(execFile);
const MAX_PROCESSES=5000, MAX_ROWS=100;
export type ResourceKind='cpu'|'memory'|'disk';
export interface ProcessRow {pid:number;user:string;program:string;cpu_percent:number|null;memory_bytes:number}
export interface DirectoryRow {path:string;bytes:number}
const clean=(value:string)=>value.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,512);

/** ps only returns executable names, never command arguments or environment variables. */
export function parseProcessList(text:string):ProcessRow[] {
 return text.split('\n').flatMap(line=>{
  const match=/^\s*(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
  if(!match)return [];
  const pid=Number(match[1]),rss=Number(match[3]),cpu=Number(match[4]);
  if(!Number.isSafeInteger(pid)||!Number.isFinite(rss)||!Number.isFinite(cpu))return [];
  return [{pid,user:clean(match[2]),memory_bytes:rss*1024,cpu_percent:cpu,program:clean(match[5])}];
 });
}
export function parseProcessTicks(text:string):{ticks:number;start:string}|null {
 const close=text.lastIndexOf(')');if(close<0)return null;
 const parts=text.slice(close+1).trim().split(/\s+/),ticks=Number(parts[11])+Number(parts[12]);
 return parts.length>19&&Number.isFinite(ticks)&&/^\d+$/.test(parts[19])?{ticks,start:parts[19]}:null;
}
async function tickSnapshot(rows:ProcessRow[]):Promise<Map<number,{ticks:number;start:string;at:number}>> {
 const values=new Map<number,{ticks:number;start:string;at:number}>();
 for(let start=0;start<rows.length;start+=64)await Promise.all(rows.slice(start,start+64).map(async row=>{
  try{const value=parseProcessTicks(await readFile(`/proc/${row.pid}/stat`,'utf8'));if(value)values.set(row.pid,{...value,at:performance.now()});}catch{/* process exited or is inaccessible */}
 }));
 return values;
}
async function collectProcesses() {
 const {stdout}=await exec('ps',['-eo','pid=,user=,rss=,pcpu=,comm='],{encoding:'utf8',timeout:4000,maxBuffer:2*1024*1024,env:{...process.env,LC_ALL:'C'}});
 const parsed=parseProcessList(stdout),partial=parsed.length>MAX_PROCESSES,rows=parsed.slice(0,MAX_PROCESSES);
 let cpu_method:'sampled'|'ps_average'='ps_average';
 if(process.platform==='linux') {
  const tickResult=await exec('getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000}).catch(()=>null);
  const tickRate=Number(tickResult?.stdout.trim());
  if(Number.isFinite(tickRate)&&tickRate>0){
   const before=await tickSnapshot(rows);await new Promise(resolve=>setTimeout(resolve,400));const after=await tickSnapshot(rows),maxCpu=cpus().length*100;
   for(const row of rows){const a=before.get(row.pid),b=after.get(row.pid);const seconds=a&&b?Math.max(.001,(b.at-a.at)/1000):0;row.cpu_percent=a&&b&&a.start===b.start&&b.ticks>=a.ticks?Math.min(maxCpu,(b.ticks-a.ticks)/tickRate/seconds*100):null;}
   cpu_method='sampled';
  }
 }
 return {rows,partial,cpu_method,sampled_at:new Date().toISOString()};
}
let processInFlight:ReturnType<typeof collectProcesses>|null=null;
export async function readProcessBreakdown(kind:'cpu'|'memory') {
 const promise=processInFlight??(processInFlight=collectProcesses().finally(()=>{processInFlight=null;}));
 const result=await promise;
 const rows=[...result.rows].sort((a,b)=>kind==='cpu'?(b.cpu_percent??-1)-(a.cpu_percent??-1):b.memory_bytes-a.memory_bytes).slice(0,MAX_ROWS);
 return {...result,rows};
}
export function parseDirectoryUsage(text:string,mount:string):DirectoryRow[] {
 return text.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(.+)$/.exec(line);if(!match||match[2]===mount)return [];
  const kb=Number(match[1]);return Number.isSafeInteger(kb)&&kb>=0?[{path:clean(match[2]),bytes:kb*1024}]:[];
 }).sort((a,b)=>b.bytes-a.bytes).slice(0,MAX_ROWS);
}
let diskInFlight:{path:string;promise:Promise<{rows:DirectoryRow[];partial:boolean;mount:string;path:string;sampled_at:string}>}|null=null;
const diskCache=new Map<string,{until:number;data:{rows:DirectoryRow[];partial:boolean;mount:string;path:string;sampled_at:string}}>();
export async function readDirectoryBreakdown(requestedPath?:string,force=false) {
 const sample=await serverResourceSampler.read(),mount=sample.disk?.mount;if(!mount||!mount.startsWith('/'))throw Error('Cannot determine the server disk mount');
 const root=await realpath(mount),path=await realpath(requestedPath||root),inside=relative(root,path);
 if(isAbsolute(inside)||inside==='..'||inside.startsWith('../'))throw Error('Directory is outside the server disk');
 const [rootInfo,info]=await Promise.all([stat(root),stat(path)]);if(!info.isDirectory()||rootInfo.dev!==info.dev)throw Error('Directory is outside the server disk');
 const key=JSON.stringify([root,path]),cached=diskCache.get(key);if(!force&&cached&&cached.until>Date.now())return {...cached.data,cached:true};
 if(diskInFlight){if(diskInFlight.path!==path)throw Error('Another directory scan is running; try again shortly');return diskInFlight.promise;}
 const promise=(async()=>{
  let output='',partial=false;
  try{const result=await exec('du',['-x','-k','-d','1',path],{encoding:'utf8',timeout:8000,maxBuffer:2*1024*1024,env:{...process.env,LC_ALL:'C'}});output=result.stdout;partial=!!result.stderr.trim();}
  catch(error){const failure=error as {stdout?:string};output=failure.stdout||'';partial=true;if(!output)throw Error('Directory scan did not finish; access may be restricted or the scan timed out');}
  const data={rows:parseDirectoryUsage(output,resolve(path)),partial,mount:root,path,sampled_at:new Date().toISOString()};diskCache.delete(key);diskCache.set(key,{data,until:Date.now()+60000});if(diskCache.size>32)diskCache.delete(diskCache.keys().next().value!);return data;
 })().finally(()=>{diskInFlight=null;});diskInFlight={path,promise};return promise;
}
