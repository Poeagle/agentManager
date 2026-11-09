import {spawnSync} from 'child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,statSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {EXPORT_HISTORY_BUNDLE,IMPORT_HISTORY_BUNDLE,FLATTEN_HISTORY} from '../src/services/agents/codex/history-bundle.js';
let dir:string,home:string,root:string,parent:string,prefix:string;
const a='019ff001-1111-7111-8111-111111111111',b='019ff001-2222-7222-8222-222222222222';
const line=(ordinal:number,type:string,payload:any)=>JSON.stringify({ordinal,type,payload})+'\n';
function run(code:string,options:unknown,input?:Buffer){return spawnSync('python3',['-c','import json\noptions=json.loads('+JSON.stringify(JSON.stringify(options))+')\n'+code],{input,maxBuffer:8*1024*1024});}
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'codex-portable-history-'));home=join(dir,'home');mkdirSync(join(home,'sessions'),{recursive:true});parent=join(home,'sessions','rollout-parent-'+a+'.jsonl');root=join(home,'sessions','rollout-child-'+b+'.jsonl');prefix=line(0,'session_meta',{id:a,session_id:a,history_mode:'paginated'})+line(1,'event_msg',{type:'user_message',message:'KEEP CONTEXT'})+line(2,'response_item',{type:'function_call_output',output:'KEEP TOOL RESULT'});writeFileSync(parent,prefix+line(3,'event_msg',{type:'user_message',message:'DO NOT COPY FUTURE BRANCH'}));writeFileSync(root,line(3,'session_meta',{id:b,session_id:a,history_mode:'paginated',history_base:{thread_id:a,end_ordinal_exclusive:3,end_byte_offset:Buffer.byteLength(prefix)}})+line(4,'event_msg',{type:'agent_message',message:'KEEP CHILD'}));});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
describe('portable paginated native history',()=>{
 it('projects inherited turns in causal order without later sibling records or source mutation',()=>{const original=readFileSync(root);const result=run(FLATTEN_HISTORY,{home,path:root});expect(result.status).toBe(0);expect(result.stdout.toString()).toBe(prefix+original.toString());expect(result.stdout.toString()).not.toContain('DO NOT COPY');expect(readFileSync(root)).toEqual(original);});
 it('preserves complete ancestor prefixes and tools without copying later branch records or colliding with target IDs',()=>{
  const before=readFileSync(root);const result=run(EXPORT_HISTORY_BUNDLE,{home,path:root});expect(result.stderr.toString()).toBe('');expect(result.status).toBe(0);
  const target=join(dir,'target');const imported=run(IMPORT_HISTORY_BUNDLE,{directory:target},result.stdout);expect(imported.stderr.toString()).toBe('');expect(imported.status).toBe(0);
  const manifest=JSON.parse(readFileSync(join(target,'manifest.json'),'utf8'));expect(manifest.ids).toHaveLength(2);expect(manifest.ids).not.toContain(a);expect(manifest.ids).not.toContain(b);
  const child=readFileSync(join(target,manifest.root),'utf8'),meta=JSON.parse(child.split('\n')[0]);const ancestor=readdirSync(target).find(n=>n.endsWith(meta.payload.history_base.thread_id+'.jsonl'))!;const data=readFileSync(join(target,ancestor),'utf8');expect(data).toContain('KEEP TOOL RESULT');expect(data).not.toContain('DO NOT COPY');expect(meta.payload.history_base.end_byte_offset).toBe(Buffer.byteLength(data));expect(child).toContain('KEEP CHILD');expect(statSync(join(target,manifest.root)).mode&0o777).toBe(0o600);expect(readFileSync(root)).toEqual(before);
 });
 it('rejects a missing ancestor before producing a usable import',()=>{rmSync(parent);const result=run(EXPORT_HISTORY_BUNDLE,{home,path:root});expect(result.status).not.toBe(0);expect(result.stderr.toString()).toContain('missing history ancestor');});
 it('rejects a corrupt prefix ordinal instead of losing native context',()=>{const meta=JSON.parse(readFileSync(root,'utf8').split('\n')[0]);meta.payload.history_base.end_ordinal_exclusive=9;writeFileSync(root,JSON.stringify(meta)+'\n');const result=run(EXPORT_HISTORY_BUNDLE,{home,path:root});expect(result.status).not.toBe(0);expect(result.stderr.toString()).toContain('ordinal mismatch');});
 it('rejects a source outside the selected account history roots',()=>{const result=run(EXPORT_HISTORY_BUNDLE,{home:join(dir,'other'),path:root});expect(result.status).not.toBe(0);expect(result.stderr.toString()).toContain('outside account');});
});
