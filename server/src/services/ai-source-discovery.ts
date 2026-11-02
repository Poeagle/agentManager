import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
const execute=promisify(execFile);
export interface AiClientDiscovery {
 kind:'codex'|'claude';installed:boolean;executable:string|null;version:string|null;
 login:'detected'|'expired'|'not_detected';credential_source:'local'|'environment'|null;
 expires_at:string|null;default_model:string|null;models:Array<{id:string;name:string}>;models_observed_at:string|null;
}
const validModel=(value:unknown):value is string=>typeof value==='string'&&/^[\w.:/+\-]{1,160}$/.test(value);
async function limitedText(path:string,limit=512000){const file=await open(path,'r');try{const info=await file.stat();if(info.size>limit)throw Error('large metadata');return await file.readFile('utf8');}finally{await file.close();}}
async function json(path:string,limit?:number):Promise<any>{try{return JSON.parse(await limitedText(path,limit));}catch{return null;}}
function expiry(value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)return null;const timestamp=value<1e11?value*1000:value;return timestamp<=8640000000000000?timestamp:null;}
function tokenExpiry(value:unknown){if(typeof value!=='string')return null;try{return expiry(JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString()).exp);}catch{return null;}}
async function inspectClient(kind:'codex'|'claude'):Promise<AiClientDiscovery>{
 const root=kind==='codex'?process.env.CODEX_HOME||join(homedir(),'.codex'):process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude');
 const result:AiClientDiscovery={kind,installed:false,executable:null,version:null,login:'not_detected',credential_source:null,expires_at:null,default_model:null,models:[],models_observed_at:null};
 try{const found=(await execute('/bin/sh',['-c','command -v -- "$1"','ai-discovery',kind],{timeout:2000,maxBuffer:4096})).stdout.trim();result.executable=await realpath(found);result.installed=true;try{result.version=(await execute(result.executable,['--version'],{timeout:3000,maxBuffer:8192})).stdout.match(/\b\d+\.\d+\.\d+(?:[-.][\w.-]+)?/)?.[0]||null;}catch{/* A version failure does not justify running inference. */}}catch{/* Detection never installs software. */}
 const credentials=await json(join(root,kind==='codex'?'auth.json':'.credentials.json'));
 const envKeys=kind==='codex'?['OPENAI_API_KEY','CODEX_API_KEY']:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'];
 if(envKeys.some(key=>!!process.env[key])){result.login='detected';result.credential_source='environment';}
 else {
  const access=kind==='codex'?credentials?.tokens?.access_token:credentials?.claudeAiOauth?.accessToken;
  const apiKey=kind==='codex'?credentials?.OPENAI_API_KEY:null;
  if(typeof access==='string'&&access||typeof apiKey==='string'&&apiKey){const until=kind==='claude'?expiry(credentials?.claudeAiOauth?.expiresAt):tokenExpiry(access);result.login=until&&until<=Date.now()?'expired':'detected';result.credential_source='local';result.expires_at=until?new Date(until).toISOString():null;}
 }
 if(kind==='codex'){
  try{const top=(await limitedText(join(root,'config.toml'))).split(/^\s*\[/m,1)[0],raw=/^\s*model\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/m.exec(top)?.[1],model=raw?JSON.parse(raw):null;if(validModel(model))result.default_model=model;}catch{/* Optional user configuration. */}
  const catalog=await json(join(root,'models_cache.json'),2*1024*1024);
  if(Array.isArray(catalog?.models))result.models=[...new Map<string,{id:string;name:string}>(catalog.models.filter((item:any)=>validModel(item?.slug)&&!['hidden','hide'].includes(item.visibility)).sort((a:any,b:any)=>(Number(a.priority)||0)-(Number(b.priority)||0)).slice(0,100).map((item:any)=>({id:item.slug,name:typeof item.display_name==='string'?item.display_name.slice(0,160):item.slug})).map((item:{id:string;name:string})=>[item.id,item])).values()];
  if(typeof catalog?.fetched_at==='string'&&Number.isFinite(Date.parse(catalog.fetched_at)))result.models_observed_at=catalog.fetched_at;
 }else{
  const settings=await json(join(root,'settings.json'));if(validModel(settings?.model))result.default_model=settings.model;
 }
 // A configured custom model may be absent from a cached catalogue. Preserve it
 // as a candidate without asserting that account/model access was verified.
 if(result.default_model&&!result.models.some(model=>model.id===result.default_model))result.models.unshift({id:result.default_model,name:result.default_model});
 return result;
}
let cached:{key:string;until:number;clients:AiClientDiscovery[]}|undefined;
let loading:{key:string;promise:Promise<AiClientDiscovery[]>}|undefined;
/** Read-only host metadata: no login refresh, model request, custom executable,
 * project configuration, installation or account credential contents returned. */
export async function availableAiClients(force=false){
 const key=JSON.stringify([process.env.PATH,process.env.CODEX_HOME,process.env.CLAUDE_CONFIG_DIR,['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'].map(key=>!!process.env[key])]);
 if(!force&&cached?.key===key&&cached.until>Date.now())return cached.clients;
 if(loading?.key===key)return loading.promise;
 const promise=Promise.all([inspectClient('codex'),inspectClient('claude')]);loading={key,promise};
 try{const clients=await promise;cached={key,until:Date.now()+60000,clients};return clients;}finally{if(loading?.promise===promise)loading=undefined;}
}
