import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,rm,symlink,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {USAGE_SCAN} from '../src/services/agents/codex/usage-scanner.js';
let home:string,file:string;
function scan(mode='full',day='2026-01-02',options:Record<string,unknown>={}){return new Promise<any>((resolve,reject)=>{const child=execFile('python3',['-c',USAGE_SCAN],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(JSON.parse(out)));child.stdin!.end(JSON.stringify({home,mode,day,...options}));});}
const meta=JSON.stringify({type:'session_meta',payload:{cwd:'/project'}})+'\n';
const context=JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol'}})+'\n';
const record=(stamp:string,total:number,last:number)=>JSON.stringify({type:'event_msg',timestamp:stamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last,input_tokens:last,output_tokens:0}}}})+'\n';
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'codex-usage-test-'));await mkdir(join(home,'sessions'));file=join(home,'sessions','rollout-test.jsonl');});
afterEach(async()=>{await rm(home,{recursive:true,force:true});});
describe('account-scoped complete-file scanner',()=>{
 it('does not charge imported paginated history or inherited snapshot notifications to the destination Engine',async()=>{
  const parent='019ff001-1111-7111-8111-111111111111',child='019ff001-2222-7222-8222-222222222222';
  const ancestor=JSON.stringify({type:'session_meta',payload:{id:parent,cwd:'/project'}})+'\n'+context+record('2026-01-02T10:00:00Z',500,100);
  const ancestorPath=join(home,'sessions',`rollout-${parent}.jsonl`);await writeFile(ancestorPath,ancestor+record('2026-01-02T11:00:00Z',900,400));
  await writeFile(file,JSON.stringify({type:'session_meta',timestamp:'2026-01-02T12:00:00Z',payload:{id:child,cwd:'/project',forked_from_id:parent,timestamp:'2026-01-02T12:00:00Z',history_base:{thread_id:parent,end_byte_offset:Buffer.byteLength(ancestor)}}})+'\n'+context+record('2026-01-02T12:00:01Z',500,100)+record('2026-01-02T13:00:00Z',520,20));
  const options={origins:{[parent]:{exclude:true},[child]:{after:'2026-01-02T11:59:59Z'}}};const result=await scan('full','2026-01-02',options);expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({requests:1,tokens:{total_tokens:20}});expect(result.errors).toBe(0);expect(result.progress.lineage_bytes_read).toBeGreaterThan(0);expect(result.progress.lineage_bytes_read).toBeLessThan(1024);
  const again=await scan('full','2026-01-02',{...options,known_events:result.event_keys['2026-01-02']});expect(again.rows).toEqual([]);expect(again.event_keys).toEqual({});
 });
 it('uses native fork boundaries for legacy copies and keeps independent new turns distinct at identical timestamps',async()=>{
  const forked=JSON.stringify({type:'session_meta',payload:{id:'fork',forked_from_id:'source',timestamp:'2026-01-02T12:30:00Z',cwd:'/project'}})+'\n';
  await writeFile(file,forked+context+record('2026-01-02T12:00:00Z',500,100)+record('2026-01-02T13:00:00Z',530,30));expect((await scan()).rows[0]).toMatchObject({requests:1,tokens:{total_tokens:30}});
  for(const turn of ['first-new-turn','second-new-turn'])await writeFile(join(home,'sessions',turn+'.jsonl'),meta+JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol',turn_id:turn}})+'\n'+record('2026-01-02T13:00:00Z',100,100));const combined=await scan();expect(combined.rows[0]).toMatchObject({requests:3,tokens:{total_tokens:230}});
 });
 it('does not interpret compaction summaries or replayed cumulative snapshots as extra requests',async()=>{
  const turn=JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol',turn_id:'actual-turn'}})+'\n';
  await writeFile(file,meta+turn+record('2026-01-02T12:00:00Z',100,100)+JSON.stringify({type:'compacted',payload:{message:'summary',replacement_history:[]}})+'\n'+record('2026-01-02T12:01:00Z',100,100)+record('2026-01-02T12:02:00Z',120,20));const first=await scan();expect(first.rows[0]).toMatchObject({requests:2,tokens:{total_tokens:120}});
  await writeFile(file,meta+turn+record('2026-01-02T12:03:00Z',120,20));expect((await scan('full','2026-01-02',{known_events:first.event_keys['2026-01-02']})).rows).toEqual([]);
 });
 it('marks unavailable lineage as partial instead of charging an unverified inherited baseline',async()=>{
  await writeFile(file,JSON.stringify({type:'session_meta',payload:{cwd:'/project',history_base:{thread_id:'missing',end_byte_offset:123}}})+'\n'+record('2026-01-02T12:00:00Z',100,100));const result=await scan();expect(result.rows).toEqual([]);expect(result.partial).toBe(true);expect(result.errors).toBeGreaterThan(0);
 });
 it('emits stable request identities so deleted source files and copied history cannot be charged twice',async()=>{
  const first=record('2026-01-02T12:00:00Z',100,100);await writeFile(file,meta+context+first);const initial=await scan();const known=initial.event_keys['2026-01-02'];expect(Buffer.from(known,'base64')).toHaveLength(32);
  expect((await scan('full','2026-01-02',{known_events:known})).rows).toEqual([]);
  await writeFile(join(home,'sessions','copy.jsonl'),meta+context+first+record('2026-01-02T13:00:00Z',150,50));await rm(file);const next=await scan('full','2026-01-02',{known_events:known});expect(next.rows[0]).toMatchObject({requests:1,tokens:{total_tokens:50}});expect(Buffer.from(next.event_keys['2026-01-02'],'base64')).toHaveLength(32);
 });
 it('respects a fixed legacy boundary, while keeping native model metadata before that boundary',async()=>{
  await writeFile(file,meta+context+record('2026-01-02T12:00:00Z',100,100)+record('2026-01-02T13:00:00Z',150,50));const result=await scan('full','2026-01-02',{baseline_at:'2026-01-02T12:30:00Z'});expect(result.rows[0]).toMatchObject({model:'gpt-6.1-sol',requests:1,tokens:{total_tokens:50}});
  await expect(scan('full','2026-01-02',{known_events:'not-base64'})).rejects.toThrow();
 });
 it('scans all history in a single pass, including a giant tool record and modern metadata',async()=>{
  const header=JSON.stringify({type:'session_meta',payload:{cwd:'/large/project',base_instructions:{text:'x'.repeat(400000)}}})+'\n';
  const tool=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(18*1024*1024)}})+'\n';
  const longContext=JSON.stringify({type:'turn_context',payload:{instructions:'x'.repeat(400000),model:'gpt-6.1-sol'}})+'\n';
  await writeFile(file,header+longContext+tool+record('2026-01-01T12:00:00Z',10,10)+record('2026-01-02T12:00:00Z',20,10));
  await mkdir(join(home,'archived_sessions'));await writeFile(join(home,'archived_sessions','old.jsonl'),meta+record('2025-01-01T12:00:00Z',4,4));
  const result=await scan();expect(result.rows).toHaveLength(3);expect(result.rows.find((r:any)=>r.day==='2026-01-01')).toMatchObject({cwd:'/large/project',model:'gpt-6.1-sol',tokens:{total_tokens:10}});
  expect(result.errors).toBe(0);expect(result.partial).toBe(false);expect(result.progress).toMatchObject({mode:'full',history_files:2,files_selected:2,files_complete:2});expect(result.progress.bytes_read).toBe(result.progress.bytes_total);
  expect(result).not.toHaveProperty('changes');expect(result).not.toHaveProperty('events');
 });
 it('selects by UTC modification day, rereads whole files and retains only today while preserving older model context',async()=>{
  await writeFile(file,meta+context+record('2026-01-01T12:00:00Z',100,100)+record('2026-01-02T12:00:00Z',150,50));
  await utimes(file,new Date('2026-01-02T10:00:00Z'),new Date('2026-01-02T10:00:00Z'));
  const old=join(home,'sessions','not-modified-today.jsonl');await writeFile(old,meta+record('2026-01-02T11:00:00Z',999,999));await utimes(old,new Date('2026-01-01T23:59:59Z'),new Date('2026-01-01T23:59:59Z'));
  const first=await scan('daily');expect(first.rows).toHaveLength(1);expect(first.rows[0]).toMatchObject({day:'2026-01-02',model:'gpt-6.1-sol',tokens:{total_tokens:50}});expect(first.progress).toMatchObject({mode:'daily',day:'2026-01-02',history_files:2,files_selected:1,files_complete:1});expect(first.progress.history_bytes).toBeGreaterThan(first.progress.bytes_total);
  expect((await scan('daily')).rows).toEqual(first.rows);
  await appendFile(file,record('2026-01-02T13:00:00Z',170,20));await utimes(file,new Date('2026-01-02T14:00:00Z'),new Date('2026-01-02T14:00:00Z'));
  expect((await scan('daily')).rows[0]).toMatchObject({requests:2,tokens:{total_tokens:70}});
  const catchup=await scan('daily','2026-01-02',{days:['2026-01-01','2026-01-02']});expect(catchup.rows.find((r:any)=>r.day==='2026-01-01').tokens.total_tokens).toBe(100);expect(catchup.progress.files_selected).toBe(2);
 });
 it('deduplicates inherited fork records, repeated snapshots and charges last-request counters only',async()=>{
  const body=meta+context+record('2026-01-02T12:00:00Z',5000,50)+record('2026-01-02T12:01:00Z',5000,50);
  await writeFile(file,body);await writeFile(join(home,'sessions','copy.jsonl'),body);
  const result=await scan();expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({requests:1,tokens:{total_tokens:50}});
 });
 it('returns stable bounded request fingerprints for cross-engine deduplication',async()=>{
  const body=JSON.stringify({type:'session_meta',payload:{cwd:'/project',model_provider:'fixture-provider'}})+'\n'+context+record('2026-01-02T12:00:00Z',5000,50);await writeFile(file,body);await writeFile(join(home,'sessions','copy.jsonl'),body);
  const first=await scan('full','2026-01-02',{includeEvents:true}),second=await scan('full','2026-01-02',{includeEvents:true});
  expect(first.events).toHaveLength(1);expect(first.events[0]).toMatchObject({key:expect.stringMatching(/^[a-f0-9]{64}$/),day:'2026-01-02',provider:'fixture-provider',tokens:{total_tokens:50}});expect(first.events).toEqual(second.events);expect(first.events_truncated).toBe(false);
 });
 it('handles UTC timestamp boundaries and a reordered outer type without assuming local timezone',async()=>{
  const r=JSON.parse(record('2026-01-03T00:30:00+08:00',10,10));await writeFile(file,meta+JSON.stringify({payload:r.payload,timestamp:r.timestamp,type:r.type})+'\n');
  await utimes(file,new Date('2026-01-02T23:00:00Z'),new Date('2026-01-02T23:00:00Z'));
  expect((await scan('daily')).rows[0].day).toBe('2026-01-02');
 });
 it('does not let missing fields poison complete requests in the same model aggregate',async()=>{
  const complete=JSON.parse(record('2026-01-02T12:00:00Z',100,100));complete.payload.info.last_token_usage.cached_input_tokens=50;const partial=JSON.parse(record('2026-01-02T13:00:00Z',120,20));delete partial.payload.info.last_token_usage.input_tokens;
  await writeFile(file,meta+context+[complete,partial].map(r=>JSON.stringify(r)+'\n').join(''));const result=await scan();expect(result.rows).toHaveLength(2);expect(result.rows.find((r:any)=>r.tokens.input_tokens===100).tokens.cached_input_tokens).toBe(50);expect(result.rows.find((r:any)=>r.tokens.input_tokens===null).tokens.total_tokens).toBe(20);
 });
 it('does not follow symlinks, reports malformed or incomplete lines and recovers by rereading',async()=>{
  const next=record('2026-01-02T12:00:00Z',100,100);await writeFile(file,meta+'broken\n'+next.slice(0,-4));
  const partial=await scan();expect(partial.rows).toHaveLength(0);expect(partial.partial).toBe(true);
  await appendFile(file,next.slice(-4));expect((await scan()).rows[0].tokens.total_tokens).toBe(100);
  await writeFile(file,meta);const secret=join(home,'auth.jsonl');await writeFile(secret,next);await symlink(secret,join(home,'sessions','escape.jsonl'));
  const result=await scan();expect(result.rows).toHaveLength(0);expect(result.errors).toBeGreaterThan(0);
 });
});
