import {getDb} from '../../db/index.js';
import {parseModelCapabilities,type ModelCapabilities} from './model-capabilities.js';

export type TokenRates={input:number;cached:number|null;output:number;cache_write_5m?:number;cache_write_1h?:number};
export type PricingBand={label?:string;min_input_tokens?:number;rates:TokenRates};
export type ModelPricing={currency:string;source:string;reference_only?:boolean;provider_multiplier?:number;bands?:PricingBand[];peak?:TokenRates;off_peak?:TokenRates;timezone?:string;peak_hours?:number[][]};
export type Tariff=ModelCapabilities&{bands:PricingBand[];release_date?:string;version?:string};
export type PricingData={models:Record<string,Tariff>;peak_hours?:number[][];speeds?:Record<string,Record<string,{subscription:number;credits:number;after?:{at:number;credits:number}}>>};
type Snapshot={from:number;checked:number;data:PricingData};
export type PublicApiCatalog='openai'|'claude'|'xai'|'gemini'|'kimi'|'glm';
type TokenCatalog=PublicApiCatalog|'openrouter';
type Catalog=TokenCatalog|'codex'|'deepseek';

export const pricingSources={
 codex:'https://learn.chatgpt.com/docs/pricing.md',
 openai:'https://developers.openai.com/api/docs/pricing.md',
 claude:'https://platform.claude.com/docs/en/about-claude/pricing.md',
 deepseek:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md',
 xai:'https://docs.x.ai/developers/pricing.md',
 gemini:'https://aistudio.google.com/docs/pricing.md',
 kimi:'https://platform.kimi.ai/docs/pricing/chat',
 glm:'https://docs.z.ai/guides/overview/pricing.md',
 openrouter:'https://openrouter.ai/api/v1/models',
};
const openaiChangelog='https://developers.openai.com/api/docs/changelog.md';
const claudeFull='https://platform.claude.com/llms-full.txt';
// Anthropic launch announcement and the public Claude API pricing table.
const sonnet55:Tariff={release_date:'2026-09-28',bands:[{rates:{input:2,cached:0.1,output:10,cache_write_5m:2.5,cache_write_1h:4}}]};
const calendarSources:Record<number,string>={2026:'https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html',2027:'https://www.shache.gov.cn/scx/c118335/202611/6dbd74b2ceba40f886c7decc9a81e527.shtml'};
const catalogs=Object.keys(pricingSources) as Catalog[];
const current=new Map<Catalog,Snapshot[]>();
const calendars=new Map<number,Array<[string,string]>>();
let interval:ReturnType<typeof setTimeout>|undefined;
let run:Promise<void>|undefined,controller:AbortController|undefined;

export function pricingSnapshot(catalog:Catalog,at=Infinity):Snapshot|undefined{
 return current.get(catalog)?.find(snapshot=>snapshot.from<=at);
}
export function publishedHolidays(year:number){return calendars.get(year);}
function apiModelId(catalog:TokenCatalog,model:string){
 const id=catalog==='claude'?model.replace(/\[1m\]$/i,''):model;
 return catalog==='openai'||catalog==='claude'?id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/,''):id;
}
export function publicApiModel(catalog:TokenCatalog,model:string){
 const models=pricingSnapshot(catalog)?.data.models;
 const id=apiModelId(catalog,model);
 const tariff=models&&Object.hasOwn(models,id)?models[id]:catalog==='claude'&&id==='claude-sonnet-5-5'?sonnet55:undefined;
 return tariff?{release_date:tariff.release_date??(catalog==='claude'&&id==='claude-sonnet-5-5'?sonnet55.release_date:undefined),context_window:tariff.context_window,input_modalities:tariff.input_modalities,api_pricing:{currency:'USD',source:pricingSources[catalog],bands:tariff.bands} satisfies ModelPricing}:undefined;
}

export function apiTariffAt(catalog:TokenCatalog,model:string,at:number){
 const snapshot=pricingSnapshot(catalog,at);
 const models=snapshot?.data.models;
 const id=apiModelId(catalog,model);
 const tariff=models&&Object.hasOwn(models,id)?models[id]:undefined;
 if(catalog!=='openai'||!snapshot||!tariff||tariff.bands.length!==2||!tariff.bands.every(band=>band.min_input_tokens===undefined))return tariff;

 // Older OpenAI snapshots stored both prices but omitted the context boundary.
 // Use the next snapshot only when both tiers have the same labels and prices.
 const snapshots=current.get(catalog);
 const next=snapshots?.[snapshots.indexOf(snapshot)-1];
 const newer=next&&Object.hasOwn(next.data.models,id)?next.data.models[id]:undefined;
 const boundary=newer?.bands[1]?.min_input_tokens;
 if(newer?.bands.length!==2||newer.bands[0].min_input_tokens!==0||boundary===undefined||!Number.isSafeInteger(boundary)||boundary<=0)return tariff;
 const sameBands=tariff.bands.every((band,index)=>band.label===newer.bands[index].label &&
   JSON.stringify(band.rates)===JSON.stringify(newer.bands[index].rates));
 if(!sameBands)return tariff;
 const [standard,long]=tariff.bands;
 return {...tariff,bands:[{...standard,min_input_tokens:0},{...long,min_input_tokens:boundary}]};
}

export function estimatePublicApiCost(catalog:TokenCatalog,model:string|null,at:string|null,tokens:Record<string,number|null>|null,cacheWrites?:readonly [number,number]){
 const tariff=at&&model?apiTariffAt(catalog,model,Date.parse(at)):undefined;
 if(!tariff||!tokens||tokens.input_tokens==null)return null;
 const band=tariff.bands.length===1?tariff.bands[0]:tariff.bands.every(band=>band.min_input_tokens!=null)
  ?tariff.bands.filter(band=>tokens.input_tokens!>=band.min_input_tokens!).at(-1):undefined;
 if(!band)return null;
 const rate=band.rates;
 const [write5,write60]=cacheWrites??[0,0];
 if(![write5,write60].every(value=>Number.isSafeInteger(value)&&value>=0)||write5&&rate.cache_write_5m==null||write60&&rate.cache_write_1h==null)return null;
 const breakdown=tokenPriceBreakdown({...tokens,input_tokens:tokens.input_tokens-write5-write60},rate);
 if(!breakdown)return null;
 breakdown.input+=(write5*(rate.cache_write_5m??0)+write60*(rate.cache_write_1h??0))/1e6;
 return {amount:breakdown.input+breakdown.cache+breakdown.output,breakdown};
}

export function tokenPriceBreakdown(tokens:Record<string,number|null>,rates:TokenRates){
 const {input_tokens:input,cached_input_tokens:cached,output_tokens:output}=tokens;
 if(input==null||cached==null||output==null||![input,cached,output].every(value=>Number.isSafeInteger(value)&&value>=0)||cached>input||cached>0&&rates.cached===null)return null;
 const reasoning=tokens.reasoning_output_tokens;
 return {input:(input-cached)*rates.input/1e6,cache:cached*(rates.cached??0)/1e6,output:output*rates.output/1e6,
  reasoning:reasoning!=null&&Number.isSafeInteger(reasoning)&&reasoning>=0&&reasoning<=output?reasoning*rates.output/1e6:null};
}

export function tokenPrice(tokens:Record<string,number|null>,rates:TokenRates):number|null{
 const cost=tokenPriceBreakdown(tokens,rates);
 return cost?cost.input+cost.cache+cost.output:null;
}

const cells=(line:string)=>line.trim().slice(1,-1).split('|').map(value=>value.trim());
const rows=(text:string)=>text.split('\n').filter(line=>line.trim().startsWith('|')).map(cells);
const decimals=(value:string,symbol='$')=>{
 const clean=value.trim().replaceAll(',','').replace(/^\\\$/,'$');
 const match=symbol==='元'?/^(\d+(?:\.\d+)?)元$/.exec(clean):/^\$(\d+(?:\.\d+)?)(?:$|\s*\/\s*MTok(?:<sup>\d+<\/sup>)?$)/.exec(clean);
 return match?Number(match[1]):null;
};
const modelId=(label:string)=>label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
const codexModelId=(label:string)=>label.trim().toLowerCase().replace(/\s+/g,'-');
const rates=(input:number|null,cached:number|null,output:number|null):TokenRates|null=>input===null||output===null?null:{input,cached,output};

function parseCodex(text:string):PricingData{
 const models:PricingData['models']={};
 const table=[...text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)].find(match=>match[0].includes('Credits per 1M tokens'))?.[0]??'';
 for(const [row] of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)){
  const parts=[...row.matchAll(/<td\b[^>]*>([^<]+)<\/td>/g)].map(match=>match[1].trim());
  if(parts.length<4||!/^GPT-[\w. ]+$/.test(parts[0]))continue;
  const amounts=parts.slice(1,4).map(value=>/^[\d,.]+ credits?$/.test(value)?Number(value.replace(/[^\d.]/g,'')):NaN);
  if(amounts.every(Number.isFinite))models[codexModelId(parts[0])]={bands:[{rates:{input:amounts[0],cached:amounts[1],output:amounts[2]}}]};
 }
 const speeds:NonNullable<PricingData['speeds']>={};
 const speedSection=text.split('## Speed multipliers')[1]?.split('## ')[0]??'';
 for(const [tier,section] of [['fast',speedSection.split('\nUltrafast\n')[0]],['ultrafast',speedSection.split('\nUltrafast\n')[1]??'']]){
  for(const [labels,a,b] of rows(section)){
   if(!/^\d+(?:\.\d+)?x$/.test(a??'')||!/^\d+(?:\.\d+)?x/.test(b??''))continue;
   const [first,later]=b.split(' / ').map(value=>parseFloat(value));
   const end=/starting (\w+ \d+, \d+) \(Pacific time\)/.exec(section)?.[1];
   const after=Number.isFinite(later)&&end?Date.parse(new Date(end+' UTC').toISOString().slice(0,10)+'T08:00:00Z'):NaN;
   if(Number.isFinite(later)&&!Number.isFinite(after))continue;
   for(const label of labels.split(/<br\s*\/?>/)) (speeds[codexModelId(label)]??={})[tier]={subscription:parseFloat(a),credits:first,...Number.isFinite(after)?{after:{at:after,credits:later}}:{}};
  }
 }
 if(!Object.keys(speeds).length)throw Error('Missing Codex speed table');
 return {models,speeds};
}

function parseOpenAI(text:string):PricingData{
 const models:PricingData['models']={};
 const standard=text.split('### Standard pricing data')[1]??'';
 const threshold=/Long context:\s*>\s*(\d+)K input tokens/i.exec(text)?.[1];
 for(const [id,input,output,cached,,,longInput,longOutput,longCache] of rows(standard.split(/\n### (?!Standard)/)[0])){
  const match=/^(gpt-[a-z\d.-]+)(?: \(<(\d+)K context length\))?$/.exec(id);
  const model=match?.[1];
  if(!model||models[model])continue;
  const rate=rates(decimals(input??''),decimals(cached??''),decimals(output??''));
  const long=rates(decimals(longInput??''),decimals(longCache??''),decimals(longOutput??''));
  const boundary=threshold?Number(threshold)*1000+1:undefined;
  if(rate)models[model]={bands:long?[{label:'短上下文',rates:rate,min_input_tokens:boundary===undefined?undefined:0},{label:'长上下文',rates:long,min_input_tokens:boundary}]:[{rates:rate}]};
 }
 return {models};
}

export function applyOpenAiReleaseDates(data:PricingData,text:string){
 let year='',month='',date='';
 for(const line of text.split('\n')){
  const section=/^## ([A-Za-z]+), (\d{4})$/.exec(line);
  if(section){[,month,year]=section;date='';continue;}
  const day=/^### [A-Za-z]+ (\d{1,2})$/.exec(line)?.[1];
  if(day&&year){const at=Date.parse(`${month} ${day}, ${year} UTC`);date=Number.isFinite(at)?new Date(at).toISOString().slice(0,10):'';}
  if(!date||!line.startsWith('Feature · Model:'))continue;
  for(const [,id] of line.matchAll(/Model: (gpt-[a-z0-9.-]+)(?= ·|$)/g)){
   if(Object.hasOwn(data.models,id)&&(!data.models[id].release_date||date<data.models[id].release_date!))data.models[id].release_date=date;
  }
 }
}

function parseOpenRouter(text:string):PricingData{
 const models:PricingData['models']=Object.create(null);
 const payload=JSON.parse(text);
 if(!Array.isArray(payload?.data))return {models};
 const price=(value:unknown)=>typeof value==='string'&&/^\d+(?:\.\d+)?(?:e-\d+)?$/i.test(value)&&Number(value)<=1?Number(value)*1e6:null;
 for(const item of payload.data){
  if(typeof item?.id!=='string'||!/^[\w.-]+\/[\w.-]+$/.test(item.id))continue;
  const pricing=item.pricing;
  if(!pricing||pricing.request!==undefined&&price(pricing.request)!==0)continue;
  const base=rates(price(pricing.prompt),price(pricing.input_cache_read),price(pricing.completion));
  if(!base)continue;
  const bands:PricingBand[]=[{min_input_tokens:0,rates:base}];
  const overrides=pricing.overrides??[];
  if(!Array.isArray(overrides)||overrides.some(rule=>!rule||Object.keys(rule).some(key=>!['min_prompt_tokens','prompt','completion','input_cache_read','input_cache_write'].includes(key))))continue;
  for(const rule of overrides){
   const min=rule.min_prompt_tokens;
   const rate=rates(price(rule.prompt),price(rule.input_cache_read),price(rule.completion));
   if(!Number.isSafeInteger(min)||min<=bands.at(-1)!.min_input_tokens!||!rate)break;
   bands.push({label:`≥ ${min.toLocaleString('en-US')} 输入 Token`,min_input_tokens:min,rates:rate});
  }
  if(bands.length!==overrides.length+1)continue;
  if(bands.length>1)bands[0].label=`< ${bands[1].min_input_tokens!.toLocaleString('en-US')} 输入 Token`;
  models[item.id]={bands,...parseModelCapabilities(item)};
 }
 return {models};
}

const grokReleases:Record<string,string>={'grok-4.5':'2026-07-16','grok-4.6':'2026-08-12','grok-4.7':'2026-09-21'};
function parseXai(text:string):PricingData{
 const models:PricingData['models']={};
 const section=text.split('### Text API Pricing')[1]?.split('\n### ')[0]??'';
 for(const [name,context,input,cached,output] of rows(section)){
  const model=/^(grok-[\w.-]+) \((<|≥) (\d+)k prompt tokens\)$/.exec(name);
  const size=/^(\d+)(k|M)$/.exec(context??'');
  const rate=rates(decimals(input??''),decimals(cached??''),decimals(output??''));
  if(!model||!size||!rate||rate.cached===null)continue;
  const [,id,operator,threshold]=model;
  const entry=models[id]??={bands:[],context_window:Number(size[1])*(size[2]==='M'?1000000:1000),release_date:grokReleases[id]};
  entry.bands.push({label:`${operator} ${threshold}k 输入 Token`,min_input_tokens:operator==='<'?0:Number(threshold)*1000,rates:rate});
 }
 for(const [id,entry] of Object.entries(models)){
  entry.bands.sort((a,b)=>a.min_input_tokens!-b.min_input_tokens!);
  if(entry.bands.length!==2||entry.bands[0].min_input_tokens!==0||!entry.bands[1].min_input_tokens)delete models[id];
 }
 return {models};
}

function parseGlm(text:string):PricingData{
 const models:PricingData['models']={};
 const price=(value:string)=>value==='Free'?0:decimals(value);
 for(const [id,input,cached,,output] of rows(text.replace(/^> /gm,''))){
  if(!/^GLM-[\w.-]+$/.test(id)||!input||!cached||!output)continue;
  const rate=rates(price(input),price(cached),price(output));
  if(rate)models[id.toLowerCase()]={bands:[{rates:rate}]};
 }
 return {models};
}

function parseKimi(text:string):PricingData{
 const models:PricingData['models']={};
 const tableEntry=/`(kimi-k[23][\w.-]*)`(?:\}\))?,`(\$[\d.]+ \/ MTok)`,`(\$[\d.]+ \/ MTok)`,`(\$[\d.]+ \/ MTok)`(?:,`(\$[\d.]+ \/ MTok)`,`(\$[\d.]+ \/ MTok)`)?\]/g;
 for(const [,id,input,output,cache,write5,write60] of text.matchAll(tableEntry)){
  const rate=rates(decimals(input),decimals(cache),decimals(output));
  if(!rate)continue;
  const writeRates=write5&&write60?{cache_write_5m:decimals(write5)!,cache_write_1h:decimals(write60)!}:{};
  models[id]={context_window:id.startsWith('kimi-k3')?1048576:262144,bands:[{rates:{...rate,...writeRates}}]};
 }
 return {models};
}

function parseGemini(text:string):PricingData{
 const models:PricingData['models']={};
 for(const section of text.split(/^## /m)){
  const id=/\{% id="(gemini-[\w.-]+)" %\}/.exec(section.split('\n')[0])?.[1];
  if(!id||/(?:live|transcribe|audio|image|tts|omni|robotics)/.test(id))continue;
  const standard=section.split('{% tab title="Standard" %}')[1]?.split('{% /tab %}')[0]??'';
  const features=standard.split(/^\s*---\s*$/m);
  const price=(label:RegExp)=>features.find(part=>label.test(part))?.trim().split('\n').filter(line=>/^\s*\* /.test(line)).at(2)?.trim().slice(2)??'';
  const textPrice=(value:string)=>decimals(/^\$[\d.]+(?=\s|$)/.exec(value)?.[0]??'');
  const input=price(/\* Input price/),output=price(/\* Output price/),cache=price(/\* Context caching price/);
  // Preserve the standard text rates only when the source identifies a single rate.
  if([input,output,cache].some(value=>/\bthrough\b|\bstarting\b|prompt|context length/i.test(value)))continue;
  const rate=rates(textPrice(input),textPrice(cache),textPrice(output));
  if(rate)models[id]={bands:[{rates:rate}]};
 }
 return {models};
}

const claudeHeader='| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |';
function parseClaude(text:string):PricingData{
 const models:PricingData['models']={};
 const table=text.split(claudeHeader)[1]?.trim().split(/\n\s*\n/)[0]??'';
 for(const [label,input,write5,write60,cache,output] of rows(table)){
  const model=/^(Claude \w+ \d+(?:\.\d+)?)(?: \((for prompts [^)]+)\))?/.exec(label);
  if(!model)continue;
  const rate=rates(decimals(input??''),decimals(cache??''),decimals(output??''));
  const cache_write_5m=decimals(write5??''),cache_write_1h=decimals(write60??'');
  if(rate&&rate.cached!==null&&cache_write_5m!==null&&cache_write_1h!==null)(models[modelId(model[1])]??={bands:[]}).bands.push({label:model[2],rates:{...rate,cache_write_5m,cache_write_1h}});
 }
 return {models};
}

function parseDeepseek(text:string):PricingData{
 const matrix=rows(text),header=matrix.find(row=>row[0]==='模型'&&row.slice(3).every(value=>/^deepseek-[\w-]+(?:\(\d+\))?$/.test(value)));
 const versions=matrix.find(row=>row[0]==='模型版本');
 const schedule=/北京时间周一至周五（不含中国法定节假日）(\d+):00\s*-\s*(\d+):00、(\d+):00\s*-\s*(\d+):00 为高峰时段/.exec(text);
 if(!header||header.length<4||!versions||!schedule)throw Error('Missing DeepSeek model or billing schedule');
 const peak_hours=[schedule.slice(1,3).map(Number),schedule.slice(3,5).map(Number)];
 if(peak_hours.some(([a,b])=>a>=b||b>24)||peak_hours[0][1]>peak_hours[1][0])throw Error('Invalid DeepSeek billing schedule');
 const models:PricingData['models']={};
 for(const [column,label] of header.entries()){
  if(column<3)continue;
  const bands=['高峰时段','空闲时段'].map(period=>{
   const price=(kind:string)=>decimals(matrix.find(row=>row[0].startsWith('价格')&&row[1].includes(kind)&&row[2]===period)?.[column]??'','元');
   const rate=rates(price('缓存未命中'),price('缓存命中'),price('输出'));
   if(!rate||rate.cached===null)throw Error('Incomplete DeepSeek tariff');
   return {rates:rate};
  });
  const id=label.replace(/\(\d+\)$/,''),version=versions[column];
  const release_date=({'DeepSeek-V4.1-Flash-1017':'2026-10-17','DeepSeek-V4-Pro-0813':'2026-08-13'} as Record<string,string>)[version];
  models[id]={bands,version,release_date};
 }
 const aliasLine=text.split('\n').find(line=>line.includes('旧模型名')&&line.includes('按 Flash 价格计费'));
 if(aliasLine&&models['deepseek-flash'])for(const [,alias] of aliasLine.matchAll(/`(deepseek-[\w-]+)`/g))models[alias]??=models['deepseek-flash'];
 return {models,peak_hours};
}

const parsers={codex:parseCodex,openai:parseOpenAI,claude:parseClaude,deepseek:parseDeepseek,xai:parseXai,gemini:parseGemini,kimi:parseKimi,glm:parseGlm,openrouter:parseOpenRouter};
export function parseOfficialPricing(catalog:Catalog,text:string):PricingData{
 const data=parsers[catalog](text);
 if(!Object.keys(data.models).length)throw Error(`No price table for ${catalog}`);
 return data;
}

async function download(url:string,fetcher:typeof fetch,signal:AbortSignal,until?:string,html=false,limit=512*1024):Promise<string>{
 const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),redirect:'error'});
 if(!response.ok||!response.body||!html&&response.headers.get('content-type')?.includes('text/html'))throw Error('Pricing document unavailable');
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let text='',bytes=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)return text+decoder.decode();
   bytes+=value.byteLength;
   if(bytes>(until?16*1024*1024:limit))throw Error('Pricing document exceeds limit');
   text+=decoder.decode(value,{stream:true});
   if(until){const start=text.indexOf(until);if(start>=0&&text.indexOf('\n\n',start)>=0)return text.slice(start);}
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

function load(catalog:Catalog){
 const snapshots=getDb().prepare('SELECT valid_from,retrieved,data FROM agent_model_pricing WHERE catalog=? ORDER BY valid_from DESC').all(catalog) as Array<{valid_from:number;retrieved:number;data:string}>;
 current.set(catalog,snapshots.map(row=>({from:row.valid_from,checked:row.retrieved,data:JSON.parse(row.data)})));
}

export async function refreshModelPricing(fetcher=fetch,signal=new AbortController().signal,now=Date.now()):Promise<void>{
 await Promise.all(catalogs.map(async catalog=>{
  try{
   const previous=pricingSnapshot(catalog)?.data.models;
   const data=await (async()=>{
    try{return parseOfficialPricing(catalog,await download(pricingSources[catalog],fetcher,signal,undefined,catalog==='kimi',catalog==='openrouter'?4*1024*1024:undefined));}
    catch(error){if(catalog!=='claude'||signal.aborted)throw error;return parseClaude(await download(claudeFull,fetcher,signal,claudeHeader));}
   })();
   if(catalog==='openai'||catalog==='xai'){
    for(const [model,tariff] of Object.entries(data.models)){
     if(!previous||!Object.hasOwn(previous,model))continue;
     tariff.release_date??=previous[model].release_date;
     tariff.context_window??=previous[model].context_window;
     tariff.input_modalities??=previous[model].input_modalities;
    }
    if(catalog==='openai'){
     try{applyOpenAiReleaseDates(data,await download(openaiChangelog,fetcher,signal));}catch{/* Retain the last known model metadata. */}
    }
    await Promise.all(Object.keys(data.models).slice(0,24).map(async model=>{
     try{
      const docs=catalog==='openai'?'https://developers.openai.com/api/docs/models/':'https://docs.x.ai/developers/models/';
      const doc=await download(`${docs}${model}.md`,fetcher,signal);
      const window=/^- ([\d,]+) context window$/m.exec(doc)?.[1];
      const modalities=(/^- Input modalities: ([a-z, ]+)$/m.exec(doc)?.[1]??/^- \*\*Modalities:\*\* ([a-z, ]+) →/m.exec(doc)?.[1])?.trim().split(/,\s*/);
      Object.assign(data.models[model],parseModelCapabilities({context_window:window?Number(window.replaceAll(',','')):undefined,input_modalities:modalities}));
     }catch{/* Model details can be unavailable even when the price table is current. */}
    }));
   }
   if(!Object.keys(data.models).length||signal.aborted)return;
   const db=getDb(),serialized=JSON.stringify(data);
   db.transaction(()=>{
    const last=db.prepare('SELECT valid_from,data FROM agent_model_pricing WHERE catalog=? ORDER BY valid_from DESC LIMIT 1').get(catalog) as {valid_from:number;data:string}|undefined;
    if(last&&last.valid_from>now)return;
    if(last?.data===serialized)db.prepare('UPDATE agent_model_pricing SET retrieved=MAX(retrieved,?) WHERE catalog=? AND valid_from=?').run(now,catalog,last.valid_from);
    else db.prepare('INSERT INTO agent_model_pricing VALUES (?,?,?,?) ON CONFLICT(catalog,valid_from) DO UPDATE SET retrieved=excluded.retrieved,data=excluded.data').run(catalog,now,now,serialized);
    db.prepare('DELETE FROM agent_model_pricing WHERE catalog=? AND valid_from NOT IN (SELECT valid_from FROM agent_model_pricing WHERE catalog=? ORDER BY valid_from DESC LIMIT 128)').run(catalog,catalog);
   })();
   load(catalog);
  }catch{/* Invalid documents leave the last validated version available. */}
 }));
}

export function parseHolidayNotice(year:number,html:string):Array<[string,string]>{
 const text=html.replace(/<[^>]+>/g,'').replace(/\s|&nbsp;/g,'');
 if(!text.includes(`国务院办公厅关于${year}年部分节假日安排的通知`))throw Error('Unrecognized holiday notice');
 const pattern=/[一二三四五六七]、(?:元旦|春节|清明节|劳动节|端午节|中秋节|国庆节)(?:、国庆节|、中秋节)?：(\d+)月(\d+)日(?:（[^）]+）)?(?:至(?:(\d+)月)?(\d+)日(?:（[^）]+）)?)?放假/g;
 const date=(month:string,day:string)=>`${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
 const periods=[...new Map([...text.matchAll(pattern)].map(([,month,day,endMonth,endDay])=>[date(month,day),date(endMonth??month,endDay??day)] as const)).entries()];
 if(periods.length!==7)throw Error('Incomplete holiday notice');
 return periods;
}

async function refreshCalendars(signal:AbortSignal){
 await Promise.all(Object.entries(calendarSources).map(async ([year,url])=>{
  try{
   const periods=parseHolidayNotice(Number(year),await download(url,fetch,signal,undefined,true));
   if(signal.aborted)return;
   getDb().prepare('INSERT OR REPLACE INTO agent_model_pricing_calendars VALUES (?,?,?,?)').run(Number(year),url,Date.now(),JSON.stringify(periods));
   calendars.set(Number(year),periods);
  }catch{/* Keep the verified calendar when the notice is unavailable. */}
 }));
}

export function initModelPricing(){
 getDb().exec('CREATE TABLE IF NOT EXISTS agent_model_pricing (catalog TEXT NOT NULL, valid_from INTEGER NOT NULL, retrieved INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(catalog,valid_from))');
 getDb().exec('CREATE TABLE IF NOT EXISTS agent_model_pricing_calendars (year INTEGER PRIMARY KEY, source TEXT NOT NULL, retrieved INTEGER NOT NULL, data TEXT NOT NULL)');
 for(const catalog of catalogs)load(catalog);
 calendars.clear();
 for(const row of getDb().prepare('SELECT year,data FROM agent_model_pricing_calendars').all() as Array<{year:number;data:string}>)calendars.set(row.year,JSON.parse(row.data));
}

export function startModelPricing(){
 if(controller)return;
 initModelPricing();
 const active=new AbortController();controller=active;
 const tick=async()=>{
  run=Promise.all([refreshModelPricing(fetch,active.signal),refreshCalendars(active.signal)]).then(()=>{});
  await run;
  if(!active.signal.aborted)interval=setTimeout(()=>void tick(),3600000).unref();
 };
 void tick();
}

export async function stopModelPricing(){controller?.abort();controller=undefined;clearTimeout(interval);await run;}
