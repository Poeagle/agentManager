import type {StoredProvider} from './management-store.js';
import {apiTariffAt,estimatePublicApiCost,publicApiModel,type PublicApiCatalog} from './model-pricing.js';
import {deepseekCatalogModel,estimateDeepseekBreakdown,isOfficialDeepSeek} from './deepseek-pricing.js';
import type {AgentModelMetadata} from './types.js';
import {storedModelCapabilities,parseModelCapabilities} from './model-capabilities.js';

type Fields = StoredProvider['fields'];
type RateVersion = {at:number;rates:Record<string,number>;providerRate?:number|null};

export function providerRateFields(base:unknown,fields?:Fields) {
  if(!base||officialApiCatalog(base)||isOfficialDeepSeek(base))return [];
  return [{key:'providerRateMultiplier',label:'Provider 计费倍率',type:'text' as const,
    value:typeof fields?.providerRateMultiplier==='string'?fields.providerRateMultiplier:'',
    description:'第三方未提供模型费率时，用此倍率折算官方参考价。'}];
}

function versions(fields?:Fields):RateVersion[] {
  return typeof fields?.modelRateVersions==='string'?JSON.parse(fields.modelRateVersions) as RateVersion[]:[];
}

export function saveModelRates(next:Fields, previous?:Fields, now=Date.now()) {
  delete next.modelRateVersions;
  const sameEndpoint=next.baseUrl===previous?.baseUrl;
  const history=sameEndpoint?versions(previous):[];
  if(previous&&!sameEndpoint&&next.providerRateMultiplier===previous.providerRateMultiplier)
    delete next.providerRateMultiplier;
  let providerRate:number|null|undefined;
  const raw=next.providerRateMultiplier;
  if(raw!==undefined){
    if(typeof raw!=='string'||(raw!==''&&(!/^\d{1,4}(?:\.\d{1,6})?$/.test(raw)||Number(raw)<=0)))
      throw Object.assign(Error('Provider 计费倍率必须为正数，最多 4 位整数和 6 位小数'),{statusCode:400});
    providerRate=raw===''?null:Number(raw);
    if(providerRate!==null&&(officialApiCatalog(next.baseUrl)||isOfficialDeepSeek(next.baseUrl)))
      throw Object.assign(Error('官方 API 按官方费率计价'),{statusCode:400});
    next.providerRateMultiplier=providerRate===null?'':String(providerRate);
  }
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
  if(providerRate!==history[0]?.providerRate||JSON.stringify(normalized)!==JSON.stringify(sameEndpoint?previous?.modelRateMultipliers??[]:[])){
    history.unshift({at:now,rates:Object.fromEntries(entries),providerRate});
  }
  next.modelRateMultipliers=normalized;
  if(history.length)next.modelRateVersions=JSON.stringify(history.slice(0,128));
}

export function modelRate(fields:Fields|undefined,model:string|null,at=Infinity):number|undefined {
  if(!model)return undefined;
  const version=versions(fields).find(version=>version.at<=at);
  if(version?.providerRate!==undefined)return version.providerRate??undefined;
  const rates=version?.rates;
  return rates&&Object.hasOwn(rates,model)?rates[model]:undefined;
}

const catalogOrigins:Record<string,PublicApiCatalog>={
  'https://api.openai.com':'openai','https://api.anthropic.com':'claude','https://api.x.ai':'xai',
  'https://generativelanguage.googleapis.com':'gemini','https://api.moonshot.ai':'kimi','https://api.z.ai':'glm',
};

export function officialApiCatalog(base:unknown):PublicApiCatalog|undefined {
  if(typeof base!=='string')return;
  try{
    const url=new URL(base);
    if(!url.username&&!url.password&&!url.search&&!url.hash&&['','/v1','/v1beta','/api/paas/v4'].includes(url.pathname.replace(/\/+$/,'')))
      return catalogOrigins[url.origin];
  }catch{return undefined;}
}

function modelApiCatalog(model:string|null):PublicApiCatalog|undefined {
  if(!model)return;
  const prefix=model.split('-')[0];
  switch(prefix){
    case 'gpt':return 'openai';
    case 'claude':return 'claude';
    case 'grok':return 'xai';
    case 'gemini':return 'gemini';
    case 'kimi':return 'kimi';
    case 'glm':return 'glm';
  }
}

const modelNamespaces:Record<string,string>={openai:'gpt-',anthropic:'claude-','x-ai':'grok-',google:'gemini-',moonshotai:'kimi-', 'z-ai':'glm-',deepseek:'deepseek-'};
function officialModelId(model:string){
  const [namespace,id,...rest]=model.split('/');
  return id&&rest.length===0&&Object.hasOwn(modelNamespaces,namespace)&&id.startsWith(modelNamespaces[namespace])?id:model;
}

function openRouterEndpoint(base:unknown){
  return typeof base==='string'&&/^https:\/\/openrouter\.ai\/api\/v1\/*$/.test(base);
}

export function providerModelMetadata(model:string,base:unknown,fields?:Fields):AgentModelMetadata {
  const id=officialModelId(model),catalog=modelApiCatalog(id);
  const info=catalog?publicApiModel(catalog,id):deepseekCatalogModel(id);
  const official=!!catalog&&catalog===officialApiCatalog(base)||isOfficialDeepSeek(base);
  const provider=openRouterEndpoint(base)?publicApiModel('openrouter',model):undefined;
  const stored=storedModelCapabilities(fields?.modelCapabilities);
  const capabilities=Object.hasOwn(stored,model)?stored[model]:undefined;
  const officialWindow=info&&'context_window' in info?info.context_window as number|undefined:undefined;
  const officialInputs=info&&'input_modalities' in info?info.input_modalities as string[]|undefined:undefined;
  return {
    release_date:info?.release_date,
    official_context_window:officialWindow,
    context_window:capabilities?.context_window??provider?.context_window??officialWindow,
    input_modalities:capabilities?.input_modalities??provider?.input_modalities??officialInputs,
    api_pricing:info?{...info.api_pricing,reference_only:!official,provider_multiplier:official||provider?undefined:modelRate(fields,model)}:undefined,
    provider_pricing:provider?.api_pricing,
  };
}

export function detectedModelMetadata(model:string,base:unknown,row:Record<string,unknown>):AgentModelMetadata{
  return {...providerModelMetadata(model,base),...parseModelCapabilities(row)};
}

export function apiPricingCurrency(base:unknown,models:unknown):'CNY'|'USD'{
  return isOfficialDeepSeek(base)||!officialApiCatalog(base)&&!openRouterEndpoint(base)&&Array.isArray(models)&&models.length>0&&
    models.every(model=>typeof model==='string'&&officialModelId(model).startsWith('deepseek-'))?'CNY':'USD';
}

export function estimateProviderApiCost(base:unknown,fields:Fields|undefined,model:string|null,at:string|null,tokens:Record<string,number|null>|null,cacheWrites?:readonly [number,number]) {
  if(!at||!model||!tokens)return null;
  const epoch=Date.parse(at);
  if(!Number.isFinite(epoch))return null;
  const official=officialApiCatalog(base),deepseek=isOfficialDeepSeek(base);
  const id=official||deepseek?model:officialModelId(model);
  const catalog=official??modelApiCatalog(id);
  const useProvider=openRouterEndpoint(base)&&!!apiTariffAt('openrouter',model,epoch);
  const useDeepseek=deepseek||!official&&!useProvider&&id.startsWith('deepseek-');
  const estimate=useProvider?estimatePublicApiCost('openrouter',model,at,tokens,cacheWrites):
    catalog&&!useDeepseek?estimatePublicApiCost(catalog,id,at,tokens,cacheWrites):null;
  const breakdown=useDeepseek?(cacheWrites?.some(Boolean)?null:estimateDeepseekBreakdown(id,epoch,tokens)):estimate?.breakdown;
  if(!breakdown)return null;
  const multiplier=official||deepseek||useProvider?1:modelRate(fields,model,epoch)??1;
  const {input,cache,output,reasoning}=breakdown;
  return {unit:useDeepseek?'CNY' as const:'USD' as const,amount:(input+cache+output)*multiplier,breakdown:{input:input*multiplier,cache:cache*multiplier,
    output:output*multiplier,reasoning:reasoning===null?null:reasoning*multiplier}};
}
