import {prepareAiSandbox,validateAiHosts} from './ai-sandbox.js';
import {spawn,execFile} from 'child_process';
import {promisify} from 'util';
import {mkdtemp,writeFile,rm} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {randomUUID} from 'crypto';
import {z} from 'zod';
export const aiSourceSchema=z.object({kind:z.enum(['api','codex','claude','command']),executable:z.string().trim().max(2048).optional(),arguments_json:z.string().max(16000).optional(),allowed_hosts_json:z.string().max(4096).optional(),credential_profile:z.enum(['none','codex','claude']).optional()}).strict().superRefine((value,ctx)=>{
 try{validateAiHosts(value.allowed_hosts_json);}catch{ctx.addIssue({code:'custom',message:'额外模型域名必须是 JSON 域名数组'});}
 if(value.kind==='command'&&!value.executable)ctx.addIssue({code:'custom',message:'请填写适配器程序路径'});
 if(value.executable?.includes('\0'))ctx.addIssue({code:'custom',message:'程序路径无效'});
 if(value.arguments_json){try{const args=JSON.parse(value.arguments_json);if(!Array.isArray(args)||args.length>64||args.some(item=>typeof item!=='string'||item.includes('\0')))throw Error();}catch{ctx.addIssue({code:'custom',message:'程序参数必须是 JSON 字符串数组'});}}
});
export type AiSource=z.infer<typeof aiSourceSchema>;
export const isClientSource=(source?:AiSource)=>!!source&&source.kind!=='api';
const execute=promisify(execFile);
export async function availableAiClients(){return Promise.all(['codex','claude'].map(async kind=>{try{await execute(kind,['--version'],{timeout:3000,maxBuffer:8192});return {kind,installed:true};}catch{return {kind,installed:false};}}));}
const replySchema={type:'object',properties:{content:{type:'string'},tool_calls:{type:'array',maxItems:8,items:{type:'object',properties:{name:{type:'string'},arguments:{type:'string'}},required:['name','arguments'],additionalProperties:false}}},required:['content','tool_calls'],additionalProperties:false};
let active=0;
/** One-shot model adapters. Built-in clients have no host tools; platform
 * tool requests are returned as data and executed by the existing RBAC loop. */
export async function runAiClient(source:AiSource,input:{messages:unknown[];tools?:unknown[];model?:string;tool_choice?:string},timeout:number,signal?:AbortSignal) {
 const config=aiSourceSchema.parse(source);if(config.kind==='api')throw Error('请选择本机客户端');if(active>=2)throw Error('本机 AI 正忙，请稍后重试');signal?.throwIfAborted();active++;
 let directory:string|undefined;let sandbox:Awaited<ReturnType<typeof prepareAiSandbox>>|undefined;
 try{
  directory=await mkdtemp(join(tmpdir(),'octoally-model-'));const schemaPath=join(directory,'reply.json');await writeFile(schemaPath,JSON.stringify(replySchema));
  const envelope={protocol:'octoally.ai.v1',...input,response_schema:replySchema};
  const instruction='Act as a stateless AI model for the supplied messages. Follow the system messages and answer the last user message. Do not use any host tools. Tools in this JSON are descriptions only: return requested tool calls as JSON data for the platform to execute. Return ONLY a JSON object matching response_schema. Each tool call arguments field must be a JSON-encoded string. If tool_choice is none, tool_calls must be empty.\n'+JSON.stringify(envelope);
  let args:string[],stdin=instruction,executable=config.executable||config.kind;
  if(config.kind==='codex')args=['exec','-c','cli_auth_credentials_store="file"','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--disable','shell_tool','--disable','plugins','-c','web_search="disabled"','--json','--output-schema',schemaPath,...(input.model?['--model',input.model]:[]),'-'];
  else if(config.kind==='claude')args=['--print','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--no-session-persistence','--output-format','json','--json-schema',JSON.stringify(replySchema),...(input.model?['--model',input.model]:[])];
  else {args=JSON.parse(config.arguments_json||'[]');stdin=JSON.stringify(envelope);}
  // Native clients need real image input rather than base64 prose. Generic
  // adapters receive the unchanged compatible image content in the envelope.
  const images:string[]=[];const collect=(value:any):void=>{if(!value||typeof value!=='object')return;if(value.type==='image_url'&&typeof value.image_url?.url==='string')images.push(value.image_url.url);else for(const item of Object.values(value))if(Array.isArray(item))item.forEach(collect);else if(item&&typeof item==='object')collect(item);};input.messages.forEach(collect);
  if(images.length&&config.kind!=='command'){
   const blocks:any[]=[];for(const [index,url] of images.entries()){const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);if(!match)throw Error('本机 AI 图片格式不支持');const path=join(directory,`image-${index}.${match[1].split('/')[1]}`);await writeFile(path,Buffer.from(match[2],'base64'));if(config.kind==='codex')args.splice(args.length-1,0,'--image',path);else blocks.push({type:'image',source:{type:'base64',media_type:match[1],data:match[2]}});}
   const text=instruction.replace(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+/g,'[attached image]');
   if(config.kind==='claude'){args.push('--input-format','stream-json');stdin=JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text},...blocks]}})+'\n';}else stdin=text;
  }
  sandbox=await prepareAiSandbox(directory,executable,args,config.allowed_hosts_json,config.kind==='codex'||config.kind==='claude'?config.kind:config.credential_profile||'none');
  const raw=await new Promise<string>((resolve,reject)=>{
   const child=spawn(sandbox!.executable,sandbox!.args,{cwd:directory,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',env:sandbox!.env});let output='',size=0,finished=false;
   const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
   const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){kill();reject(error);}else resolve(output);};
   const abort=()=>finish(Error('AI 请求已取消'));const timer=setTimeout(()=>finish(Error('本机 AI 请求超时')),timeout);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   child.on('error',()=>finish(Error('无法启动 AI 客户端，请检查安装及程序路径')));child.stdout.on('data',bytes=>{size+=bytes.length;if(size>2*1024*1024)finish(Error('AI 响应超过大小限制'));else output+=bytes.toString();});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('close',code=>finish(code===0?undefined:Error('AI 客户端运行失败，请检查登录、模型权限及客户端版本')));child.stdin.end(stdin);
  });
  let data:any;if(config.kind==='codex'){const records=raw.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});const message=records.filter(entry=>entry.type==='item.completed'&&entry.item?.type==='agent_message').at(-1);if(!message)throw Error('Codex 未返回有效模型回复');data=JSON.parse(message.item.text);}else {data=JSON.parse(raw);if(config.kind==='claude'){if(data.is_error)throw Error('Claude 请求失败，请检查登录和额度');data=data.structured_output??JSON.parse(data.result||'null');}}
  const parsed=z.object({content:z.string().max(16000),tool_calls:z.array(z.object({name:z.string().min(1).max(200),arguments:z.string().max(64000)}).strict()).max(8)}).strict().parse(data);
  const allowed=new Set((input.tools||[]).map((tool:any)=>tool.function?.name));for(const call of parsed.tool_calls){if(input.tool_choice==='none'||!allowed.has(call.name))throw Error('AI 返回了未授权的工具请求');JSON.parse(call.arguments);}
  if(!parsed.content.trim()&&!parsed.tool_calls.length)throw Error('AI 返回了空回复');
  return {role:'assistant' as const,content:parsed.content||null,...(parsed.tool_calls.length?{tool_calls:parsed.tool_calls.map(call=>({id:randomUUID(),type:'function' as const,function:call}))}:{})};
 }catch(error){if(error instanceof z.ZodError||error instanceof SyntaxError)throw Error('AI 客户端未返回约定的结构化回复，请检查适配器');throw error;}
 finally{active--;sandbox?.close();if(directory)await rm(directory,{recursive:true,force:true});}
}
