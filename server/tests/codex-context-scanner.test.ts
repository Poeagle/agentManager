import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {CONTEXT_SCAN} from '../src/services/agents/codex/context-scanner.js';
let home:string,file:string;
const native='019ff001-1212-7212-8212-121212121211',parent='019ff001-1212-7212-8212-121212121212';
const line=(type:string,payload:unknown,ordinal?:number)=>JSON.stringify({type,payload,ordinal,timestamp:'2026-11-11T12:00:00Z'})+'\n';
const meta=(id=native,base?:unknown)=>line('session_meta',{id,base_instructions:{text:'base instructions'},...base?{history_base:base}:{}},0);
const message=(role:string,text:string,ordinal?:number)=>line('response_item',{type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]},ordinal);
const scan=(path=file)=>new Promise<any>((resolve,reject)=>{const child=execFile('python3',['-c',CONTEXT_SCAN],{maxBuffer:512*1024},(error,out)=>error?reject(error):resolve(JSON.parse(out)));child.stdin!.end(JSON.stringify({home,path}));});
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'context-scan-'));await mkdir(join(home,'sessions'));file=join(home,'sessions',`rollout-${native}.jsonl`);});
afterEach(()=>rm(home,{recursive:true,force:true}));
it('classifies native response items once, maps tool results and returns counters without prompt bodies',async()=>{
 await writeFile(file,meta()+line('turn_context',{model:'fixture-model'})+message('user','private user prompt')+line('event_msg',{type:'user_message',message:'private user prompt'})+message('user','<octoally_shared_resources>\nprivate injection\n</octoally_shared_resources>')+message('assistant','private answer')+line('response_item',{type:'function_call',name:'read_file',call_id:'c',arguments:'private argument'})+line('response_item',{type:'function_call_output',call_id:'c',output:'private output'})+line('event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:100,cached_input_tokens:80,total_tokens:110,output_tokens:10},model_context_window:1000}}));
 const result=await scan();expect(result).toMatchObject({source:'jsonl',exact:false,method:'characters_div_3',partial:false,model:'fixture-model',usage:{last:{total_tokens:110},window:1000}});
 expect(result.categories.find((c:any)=>c.id==='user').count).toBe(1);expect(result.categories.find((c:any)=>c.id==='injections').detail[0].name).toBe('共享资源');expect(result.categories.find((c:any)=>c.id==='results').detail[0].name).toBe('read_file');expect(result.categories.find((c:any)=>c.id==='tools').tokens).toBeNull();expect(JSON.stringify(result)).not.toContain('private');
});
it('replaces old message and tool counters at compaction instead of counting the whole historical session',async()=>{
 await writeFile(file,meta()+message('user','old message')+line('response_item',{type:'function_call_output',output:'old tool output'})+line('compacted',{replacement_history:[{type:'message',role:'user',content:[{type:'input_text',text:'new summary'}]}]})+message('assistant','new answer'));
 const result=await scan();expect(result.compactions).toBe(1);expect(result.categories.find((c:any)=>c.id==='user').tokens).toBe(Math.ceil('new summary'.length/3));expect(result.categories.find((c:any)=>c.id==='results')).toBeUndefined();expect(result.categories.find((c:any)=>c.id==='system').tokens).toBeGreaterThan(0);
});
it('follows paginated lineage prefixes without charging records after the inherited cutoff',async()=>{
 const base=meta(parent)+message('user','inherited',1),path=join(home,'sessions',`rollout-${parent}.jsonl`);await writeFile(path,base+message('user','not inherited',2));
 await writeFile(file,meta(native,{thread_id:parent,end_byte_offset:Buffer.byteLength(base),end_ordinal_exclusive:2})+message('assistant','child'));
 const result=await scan();expect(result.files_read).toBe(2);expect(result.categories.find((c:any)=>c.id==='user').count).toBe(1);expect(result.categories.find((c:any)=>c.id==='assistant').count).toBe(1);
});
it('marks incomplete records and legacy compaction as partial and rejects paths outside the account history',async()=>{
 await writeFile(file,meta()+line('compacted',{message:'short summary'})+'{"type":');const result=await scan();expect(result.partial).toBe(true);expect(result.warnings).toContain('compaction_partial');expect(result.warnings).toContain('incomplete');
 const outside=join(home,'auth.jsonl');await writeFile(outside,message('user','private'));await expect(scan(outside)).rejects.toThrow();
});
