import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,existsSync} from 'fs';
import {tmpdir} from 'os';import {join} from 'path';
import {runAiClient,aiSourceSchema} from '../src/services/ai-source.js';
let dir:string;const reply={content:'可用',tool_calls:[]};
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'ai-adapter-test-'));});afterEach(()=>rmSync(dir,{recursive:true,force:true}));
function script(body:string){const file=join(dir,'adapter.cjs');writeFileSync(file,body);return file;}
it('supports generic adapters through JSON stdin without shell interpolation',async()=>{
 const file=script(`let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const data=JSON.parse(input);console.log(JSON.stringify({content:data.messages[0].content,tool_calls:[]}));});`);
 const message=await runAiClient({kind:'command',executable:process.execPath,arguments_json:JSON.stringify([file])},{messages:[{role:'user',content:'literal $(touch should-not-exist)'}]},3000);expect(message.content).toBe('literal $(touch should-not-exist)');
});
it.each(['codex','claude'] as const)('normalizes %s native output and disables native host tools',async kind=>{
 const file=join(dir,kind);writeFileSync(file,`#!${process.execPath}\nconst reply={content:JSON.stringify(process.argv.slice(2)),tool_calls:[]};process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify(${kind==='codex'?"{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(reply)}}":"{structured_output:reply}"})));`);chmodSync(file,0o755);
 const result=await runAiClient({kind,executable:file},{messages:[{role:'user',content:'test'}]},5000);const args=JSON.parse(result.content!);if(kind==='codex'){expect(args).toContain('--ignore-user-config');expect(args).toContain('read-only');expect(args).toContain('shell_tool');}else{expect(args).toContain('--tools');expect(args[args.indexOf('--tools')+1]).toBe('');expect(args).toContain('--strict-mcp-config');}

});
it('returns tool requests as data and rejects unlisted tools',async()=>{
 const file=script(`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({content:'',tool_calls:[{name:'read_tab',arguments:'{"id":"s"}'}]})));`),source={kind:'command' as const,executable:process.execPath,arguments_json:JSON.stringify([file])};
 const input={messages:[],tools:[{type:'function',function:{name:'read_tab'}}]};expect((await runAiClient(source,input,3000)).tool_calls?.[0]).toMatchObject({type:'function',function:{name:'read_tab',arguments:'{"id":"s"}'}});await expect(runAiClient(source,{messages:[]},3000)).rejects.toThrow('未授权');await expect(runAiClient(source,{...input,tool_choice:'none'},3000)).rejects.toThrow('未授权');
});
it('cancels/limits a hung process and redacts stderr',async()=>{
 const file=script(`process.stderr.write('Bearer PRIVATE_TOKEN');setInterval(()=>{},1000);`),source={kind:'command' as const,executable:process.execPath,arguments_json:JSON.stringify([file])};await expect(runAiClient(source,{messages:[]},100)).rejects.toThrow('超时');const controller=new AbortController();const call=runAiClient(source,{messages:[]},3000,controller.signal);controller.abort();await expect(call).rejects.toThrow();
});
it('cannot read host files, inherit server secrets, write a host file or call localhost',async()=>{
 const secret=join(dir,'host-secret'),target=join(dir,'host-write');writeFileSync(secret,'PRIVATE');process.env.OCTOALLY_TEST_SECRET='PRIVATE';
 const file=script(`const fs=require('fs');process.stdin.resume();process.stdin.on('end',async()=>{let read=false,write=false,network=false;try{fs.readFileSync(${JSON.stringify(secret)});read=true;}catch{}try{fs.writeFileSync(${JSON.stringify(target)},'bad');write=true;}catch{}try{await fetch('http://127.0.0.1:42020/api/health',{signal:AbortSignal.timeout(500)});network=true;}catch{}console.log(JSON.stringify({content:JSON.stringify({read,write,network,secret:!!process.env.OCTOALLY_TEST_SECRET}),tool_calls:[]}));});`);
 try{const reply=await runAiClient({kind:'command',executable:process.execPath,arguments_json:JSON.stringify([file])},{messages:[]},5000);expect(JSON.parse(reply.content!)).toEqual({read:false,write:true,network:false,secret:false});expect(existsSync(target)).toBe(false);}finally{delete process.env.OCTOALLY_TEST_SECRET;}
});
it('blocks egress proxy CONNECT requests to server services',async()=>{
 const file=script(`const http=require('http');process.stdin.resume();process.stdin.on('end',()=>{const proxy=new URL(process.env.HTTPS_PROXY);const request=http.request({hostname:proxy.hostname,port:proxy.port,method:'CONNECT',path:'127.0.0.1:42020'});request.on('connect',(response,socket)=>{socket.destroy();console.log(JSON.stringify({content:String(response.statusCode),tool_calls:[]}));});request.on('error',()=>process.exit(1));request.end();});`);
 const result=await runAiClient({kind:'command',executable:process.execPath,arguments_json:JSON.stringify([file])},{messages:[]},5000);expect(result.content).toBe('403');expect(aiSourceSchema.safeParse({kind:'command',executable:'adapter',allowed_hosts_json:'["127.0.0.1"]'}).success).toBe(false);
});
it('validates the extension protocol configuration',()=>{for(const source of [{kind:'other'},{kind:'command'},{kind:'command',executable:'node',arguments_json:'"not array"'}])expect(aiSourceSchema.safeParse(source).success).toBe(false);});
