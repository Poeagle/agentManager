import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {precedingPricingSettings} from '../src/services/agents/codex/statistics-settings.js';
let dir:string,path:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'pricing-settings-'));path=join(dir,'rollout.jsonl');});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const row=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
const settings=(model:string|null,tier?:string|null)=>row('turn_context',{model,...tier!==undefined?{service_tier:tier}:{}});
const noise=(n:number)=>row('event_msg',{type:'noise',data:'x'.repeat(n)});
async function read(data:string,end=Buffer.byteLength(data)){
 await writeFile(path,data);const file=await open(path,'r');try{return await precedingPricingSettings(file,end);}finally{await file.close();}
}
it('takes the nearest preceding receipt for each field, including records split across chunks',async()=>{
 expect(await read(settings('old','fast')+settings('gpt-6.1-sol')+noise(256*1024-100))).toEqual({model:'gpt-6.1-sol',tier:'fast'});
});
it('does not carry older settings through explicit null or malformed field values',async()=>{
 expect(await read(settings('old','fast')+settings(null,null))).toEqual({model:null,tier:null});
 expect(await read(settings('old','fast')+row('event_msg',{type:'thread_settings_applied',thread_settings:{model:123,service_tier:'default'}}))).toEqual({model:null,tier:'default'});
});
it('excludes a partial record and settings after the statistics boundary',async()=>{
 const before=settings('gpt-6.1-sol','fast'),after=settings('gpt-6.1-terra','default');
 expect(await read(before+after,Buffer.byteLength(before)+Math.floor(after.length/2))).toEqual({model:'gpt-6.1-sol',tier:'fast'});
});
it('ignores oversized or invalid records and stops at the cold-read budget',async()=>{
 expect(await read(settings('gpt-6.1-sol','default')+row('turn_context',{model:'wrong',service_tier:'fast',data:'x'.repeat(300*1024)}))).toEqual({model:'gpt-6.1-sol',tier:'default'});
 const padding=noise(16000).repeat(1050);
 expect(await read(settings('gpt-6.1-sol','fast')+padding)).toEqual({model:null,tier:null});
});
