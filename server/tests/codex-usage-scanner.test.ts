import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,appendFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {USAGE_SCAN} from '../src/services/agents/codex/usage-scanner.js';
let home:string,file:string;
function scan(cursors:Record<string,unknown>={}){return new Promise<any>((resolve,reject)=>{const child=execFile('python3',['-c',USAGE_SCAN],{maxBuffer:768*1024},(error,out)=>error?reject(error):resolve(JSON.parse(out)));child.stdin!.end(JSON.stringify({home,cursors}));});}
const meta=JSON.stringify({type:'session_meta',payload:{cwd:'/project'}})+'\n';
const record=(stamp:string,total:number,last:number)=>JSON.stringify({type:'event_msg',timestamp:stamp,payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{total_tokens:last,input_tokens:last,output_tokens:0}}}})+'\n';
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'codex-usage-test-'));await mkdir(join(home,'sessions'));file=join(home,'sessions','rollout-test.jsonl');});
afterEach(async()=>{await rm(home,{recursive:true,force:true});});
describe('account-scoped incremental JSONL scanner',()=>{
 it('extracts workdir from large modern metadata and does not flag oversized tool records as lost usage',async()=>{
  const header=JSON.stringify({type:'session_meta',payload:{cwd:'/large/project',base_instructions:{text:'x'.repeat(400000)}}})+'\n';
  const tool=JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(300000)}})+'\n';
  await writeFile(file,header+tool+record('2026-01-01T12:00:00Z',10,10));
  const result=await scan();expect(result.events[0].cwd).toBe('/large/project');expect(result.errors).toBe(0);expect(result.partial).toBe(false);
 });
 it('resumes at complete lines and ignores duplicate snapshots',async()=>{
  await writeFile(file,meta+record('2026-01-01T12:00:00Z',100,100));
  const first=await scan();expect(first.events).toHaveLength(1);expect(first.events[0]).toMatchObject({cwd:'/project',tokens:{total_tokens:100}});
  const cursors=Object.fromEntries(first.changes);expect((await scan(cursors)).events).toHaveLength(0);
  const next=record('2026-01-02T12:00:00Z',150,50);await appendFile(file,record('2026-01-01T12:01:00Z',100,100)+next.slice(0,-4));
  const partial=await scan(cursors);expect(partial.events).toHaveLength(0);expect(partial.partial).toBe(true);
  await appendFile(file,next.slice(-4));const final=await scan(Object.fromEntries(partial.changes));expect(final.events).toHaveLength(1);expect(final.events[0].tokens.total_tokens).toBe(50);
 });
 it('gives copied fork records the same identity and excludes cumulative baselines',async()=>{
  const body=meta+record('2026-01-01T12:00:00Z',5000,50);await writeFile(file,body);await writeFile(join(home,'sessions','copy.jsonl'),body);
  const result=await scan();expect(new Set(result.events.map((e:any)=>e.key)).size).toBe(1);expect(result.events[0].tokens.total_tokens).toBe(50);
 });
 it('replays truncations and never follows symlinks outside history',async()=>{
  await writeFile(file,meta+record('2026-01-01T12:00:00Z',100,100));const first=await scan();
  await writeFile(file,meta);const next=await scan(Object.fromEntries(first.changes));expect(next.changes[0][1].offset).toBe(Buffer.byteLength(meta));expect(next.events).toHaveLength(0);
  const secret=join(home,'auth.jsonl');await writeFile(secret,record('2026-01-01T12:00:00Z',99,99));await symlink(secret,join(home,'sessions','escape.jsonl'));
  const result=await scan();expect(result.events).toHaveLength(0);expect(result.errors).toBeGreaterThan(0);
 });
});
