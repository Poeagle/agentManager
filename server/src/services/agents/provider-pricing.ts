import type {StoredProvider} from './management-store.js';
import {estimatePublicApiCost} from './model-pricing.js';

type Fields = StoredProvider['fields'];
type RateVersion = {at:number;rates:Record<string,number>};

export function modelRateField(fields?:Fields) {
  return {key:'modelRateMultipliers',label:'模型计费倍率',type:'string-list' as const,
    value:Array.isArray(fields?.modelRateMultipliers)?fields.modelRateMultipliers:[],
    placeholder:'claude-sonnet-5-5=1.2',description:'每行填写一个已确认的模型 ID 和倍率。适用于按官方标准 API 单价乘倍率的服务。'};
}

function versions(fields?:Fields):RateVersion[] {
  return typeof fields?.modelRateVersions==='string'?JSON.parse(fields.modelRateVersions) as RateVersion[]:[];
}

export function saveModelRates(next:Fields, previous?:Fields, now=Date.now()) {
  delete next.modelRateVersions;
  const sameEndpoint=next.baseUrl===previous?.baseUrl;
  const history=sameEndpoint?versions(previous):[];
  const value=next.modelRateMultipliers??[];
  const invalid=()=>Object.assign(Error('模型计费倍率格式应为 模型ID=倍率，模型不得重复'),{statusCode:400});
  if(!Array.isArray(value)||value.length>256)throw invalid();
  const rates=new Map<string,number>();
  for(const line of value){
    const match=typeof line==='string'&&/^([A-Za-z0-9._:/@+\-[\]]{1,200})\s*=\s*(\d{1,4}(?:\.\d{1,6})?)$/.exec(line.trim());
    if(!match||rates.has(match[1])||Number(match[2])<=0)throw invalid();
    rates.set(match[1],Number(match[2]));
  }
  const entries=[...rates].sort(([a],[b])=>a.localeCompare(b));
  const normalized=entries.map(([model,rate])=>`${model}=${rate}`);
  if(JSON.stringify(normalized)!==JSON.stringify(sameEndpoint?previous?.modelRateMultipliers??[]:[])){
    history.unshift({at:now,rates:Object.fromEntries(entries)});
  }
  next.modelRateMultipliers=normalized;
  if(history.length)next.modelRateVersions=JSON.stringify(history.slice(0,128));
}

export function modelRate(fields:Fields|undefined,model:string|null,at=Infinity):number|undefined {
  if(!model)return undefined;
  const rates=versions(fields).find(version=>version.at<=at)?.rates;
  return rates&&Object.hasOwn(rates,model)?rates[model]:undefined;
}

export function estimateProviderApiCost(catalog:'openai'|'claude',fields:Fields|undefined,model:string|null,at:string|null,tokens:Record<string,number|null>|null,cacheWrites?:readonly [number,number]) {
  const multiplier=at?modelRate(fields,model,Date.parse(at)):undefined;
  if(multiplier===undefined)return null;
  const base=estimatePublicApiCost(catalog,model,at,tokens,cacheWrites);
  if(!base)return null;
  const {input,cache,output,reasoning}=base.breakdown;
  return {amount:base.amount*multiplier,breakdown:{input:input*multiplier,cache:cache*multiplier,
    output:output*multiplier,reasoning:reasoning===null?null:reasoning*multiplier}};
}
