import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,rm,symlink,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {USAGE_SCAN} from '../src/services/agents/codex/usage-scanner.js';
let home:string,file:string;
function scan(mode='full',day='2026-01-02',includeEvents=false){return new Promise<any>((resolve,reject)=>{const child=execFile('python3',['-c',USAGE_SCAN],{maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(JSON.parse(out)));child.stdin!.end(JSON.stringify({home,mode,day,includeEvents}));});}
const meta=JSON.stringify({type:'session_meta',payload:{cwd:'/project'}})+'\n';
const context=JSON.stringify({type:'turn_context',payload:{model:'gpt-6.1-sol'}})+'\n';
const record=(stamp:string,total:number,last:number)=>JSON.stringify({type:'event_msg',timestamp:stamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last,input_tokens:last,output_tokens:0}}}})+'\n';
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'codex-usage-test-'));await mkdir(join(home,'sessions'));file=join(home,'sessions','rollout-test.jsonl');});
afterEach(async()=>{await rm(home,{recursive:true,force:true});});
describe('account-scoped complete-file scanner',()=>{
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
 });
 it('deduplicates inherited fork records, repeated snapshots and charges last-request counters only',async()=>{
  const body=meta+context+record('2026-01-02T12:00:00Z',5000,50)+record('2026-01-02T12:01:00Z',5000,50);
  await writeFile(file,body);await writeFile(join(home,'sessions','copy.jsonl'),body);
  const result=await scan();expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({requests:1,tokens:{total_tokens:50}});
 });
 it('returns stable bounded request fingerprints for cross-engine deduplication',async()=>{
  const body=JSON.stringify({type:'session_meta',payload:{cwd:'/project',model_provider:'fixture-provider'}})+'\n'+context+record('2026-01-02T12:00:00Z',5000,50);await writeFile(file,body);await writeFile(join(home,'sessions','copy.jsonl'),body);
  const first=await scan('full','2026-01-02',true),second=await scan('full','2026-01-02',true);
  expect(first.events).toHaveLength(1);expect(first.events[0]).toMatchObject({key:expect.stringMatching(/^[a-f0-9]{64}$/),day:'2026-01-02',provider:'fixture-provider',tokens:{total_tokens:50}});expect(first.events).toEqual(second.events);expect(first.events_truncated).toBe(false);
 });
 it('handles UTC timestamp boundaries and a reordered outer type without assuming local timezone',async()=>{
  const r=JSON.parse(record('2026-01-03T00:30:00+08:00',10,10));await writeFile(file,meta+JSON.stringify({payload:r.payload,timestamp:r.timestamp,type:r.type})+'\n');
  await utimes(file,new Date('2026-01-02T23:00:00Z'),new Date('2026-01-02T23:00:00Z'));
  expect((await scan('daily')).rows[0].day).toBe('2026-01-02');
 });
 it('does not follow symlinks, reports malformed or incomplete lines and recovers by rereading',async()=>{
  const next=record('2026-01-02T12:00:00Z',100,100);await writeFile(file,meta+'broken\n'+next.slice(0,-4));
  const partial=await scan();expect(partial.rows).toHaveLength(0);expect(partial.partial).toBe(true);
  await appendFile(file,next.slice(-4));expect((await scan()).rows[0].tokens.total_tokens).toBe(100);
  await writeFile(file,meta);const secret=join(home,'auth.jsonl');await writeFile(secret,next);await symlink(secret,join(home,'sessions','escape.jsonl'));
  const result=await scan();expect(result.rows).toHaveLength(0);expect(result.errors).toBeGreaterThan(0);
 });
});
