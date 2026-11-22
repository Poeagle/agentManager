import {getDb} from '../../db/index.js';

export type TokenRates={input:number;cached:number|null;output:number;cache_write_5m?:number;cache_write_1h?:number};
export type PricingBand={label?:string;rates:TokenRates};
export type ModelPricing={currency:string;source:string;bands?:PricingBand[];peak?:TokenRates;off_peak?:TokenRates;timezone?:string;peak_hours?:number[][]};
export type Tariff={bands:PricingBand[];release_date?:string;version?:string};
export type PricingData={models:Record<string,Tariff>;peak_hours?:number[][];speeds?:Record<string,Record<string,{subscription:number;credits:number;after?:{at:number;credits:number}}>>};
type Snapshot={from:number;checked:number;data:PricingData};
type Catalog='codex'|'openai'|'claude'|'deepseek';

export const pricingSources={
 codex:'https://learn.chatgpt.com/docs/pricing.md',
 openai:'https://developers.openai.com/api/docs/pricing.md',
 claude:'https://platform.claude.com/docs/en/about-claude/pricing.md',
 deepseek:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md',
};
const claudeFull='https://platform.claude.com/llms-full.txt';
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
export function publicApiPricing(catalog:'openai'|'claude',model:string):ModelPricing|undefined{
 const models=pricingSnapshot(catalog)?.data.models;
 const id=model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/,'');
 const tariff=models&&Object.hasOwn(models,id)?models[id]:undefined;
 return tariff?{currency:'USD',source:pricingSources[catalog],bands:tariff.bands}:undefined;
}

export function estimatePublicApiCost(catalog:'openai'|'claude',model:string|null,at:string|null,tokens:Record<string,number|null>|null,cacheWrites?:readonly [number,number]){
 const snapshot=at?pricingSnapshot(catalog,Date.parse(at)):undefined;
 const id=model?.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/,'');
 const tariff=snapshot&&id&&Object.hasOwn(snapshot.data.models,id)?snapshot.data.models[id]:null;
 if(!tariff||!tokens||tariff.bands.length!==1)return null;
 const rate=tariff.bands[0].rates;
 const [write5,write60]=cacheWrites??[0,0];
 if(tokens.input_tokens==null||write5&&rate.cache_write_5m==null||write60&&rate.cache_write_1h==null)return null;
 const amount=tokenPrice({...tokens,input_tokens:tokens.input_tokens-write5-write60},rate);
 return amount===null?null:amount+(write5*(rate.cache_write_5m??0)+write60*(rate.cache_write_1h??0))/1e6;
}

export function tokenPrice(tokens:Record<string,number|null>,rates:TokenRates):number|null{
 const {input_tokens:input,cached_input_tokens:cached,output_tokens:output}=tokens;
 if(input==null||cached==null||output==null||![input,cached,output].every(value=>Number.isSafeInteger(value)&&value>=0)||cached>input||cached>0&&rates.cached===null)return null;
 return ((input-cached)*rates.input+cached*(rates.cached??0)+output*rates.output)/1000000;
}

const cells=(line:string)=>line.trim().slice(1,-1).split('|').map(value=>value.trim());
const rows=(text:string)=>text.split('\n').filter(line=>line.trim().startsWith('|')).map(cells);
const decimals=(value:string,symbol='$')=>{
 const clean=value.trim().replaceAll(',','');
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
 for(const [id,input,output,cached,,,longInput,longOutput,longCache] of rows(standard.split('\nFast\n')[0])){
  const model=/^(gpt-[a-z\d.-]+)(?: \(<\d+K context length\))?$/.exec(id)?.[1];
  if(!model||models[model])continue;
  const rate=rates(decimals(input??''),decimals(cached??''),decimals(output??''));
  const long=rates(decimals(longInput??''),decimals(longCache??''),decimals(longOutput??''));
  if(rate)models[model]={bands:long?[{label:'短上下文',rates:rate},{label:'长上下文',rates:long}]:[{rates:rate}]};
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

const parsers={codex:parseCodex,openai:parseOpenAI,claude:parseClaude,deepseek:parseDeepseek};
export function parseOfficialPricing(catalog:Catalog,text:string):PricingData{
 const data=parsers[catalog](text);
 if(!Object.keys(data.models).length)throw Error(`No price table for ${catalog}`);
 return data;
}

async function download(url:string,fetcher:typeof fetch,signal:AbortSignal,until?:string,html=false):Promise<string>{
 const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),redirect:'error'});
 if(!response.ok||!response.body||!html&&response.headers.get('content-type')?.includes('text/html'))throw Error('Pricing document unavailable');
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let text='',bytes=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)return text+decoder.decode();
   bytes+=value.byteLength;
   if(bytes>(until?16*1024*1024:512*1024))throw Error('Pricing document exceeds limit');
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
   const data=await (async()=>{
    try{return parseOfficialPricing(catalog,await download(pricingSources[catalog],fetcher,signal));}
    catch(error){if(catalog!=='claude'||signal.aborted)throw error;return parseClaude(await download(claudeFull,fetcher,signal,claudeHeader));}
   })();
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
