import {agentDescriptors,getAgent} from './index.js';
import {providerModelMetadata} from './provider-pricing.js';
import {
 confirmedClaudeContextWindow,confirmedClaudeInputModalities,confirmedClaudeMetadata,
 publicApiModel,type ModelPricing,type PublicApiCatalog,
} from './model-pricing.js';
import {deepseekCatalogModel} from './deepseek-pricing.js';
import type {AgentModelConfig,AgentModelMetadata,AgentProviderState} from './types.js';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const __dirname=dirname(fileURLToPath(import.meta.url));

export interface AgentModelCatalogEntry extends AgentModelMetadata {
 vendor:string;
 model:string;
 providers:string[];
}

/** A configured Provider alias is useful for sessions, but it is not an
 * official model record unless the platform can verify official metadata. */
export function hasOfficialModelMetadata(model:AgentModelMetadata):boolean {
 return model.api_pricing!=null||model.reference_credits!=null;
}

function canonicalModelName(model:string,metadata:AgentModelMetadata):string {
 return metadata.canonical_model??model;
}

function modelVendor(model:string):string{
 const id=model.toLowerCase().split('/').at(-1)??model.toLowerCase();
 if(id.startsWith('gpt-'))return 'OpenAI';
 if(id.startsWith('claude-'))return 'Anthropic';
 if(id.startsWith('deepseek-'))return 'DeepSeek';
 if(id.startsWith('grok-'))return 'xAI';
 if(id.startsWith('gemini-'))return 'Google';
 if(id.startsWith('kimi-'))return 'Moonshot';
 if(id.startsWith('glm-'))return 'Z.ai';
 return '其他';
}

function fieldValue(provider:AgentProviderState,key:string):unknown{
 return provider.fields.find(field=>field.key===key)?.value;
}

function mergeMetadata(current:AgentModelMetadata|undefined,next:AgentModelMetadata):AgentModelMetadata{
 if(!current)return next;
 const currentOfficial=current.api_pricing?.reference_only===false;
 const nextOfficial=next.api_pricing?.reference_only===false;
 const merged:AgentModelMetadata={
  ...current,
  ...next,
  canonical_model:current.canonical_model??next.canonical_model,
  release_date:current.release_date??next.release_date,
  official_context_window:current.official_context_window??next.official_context_window,
  context_window:next.official_context_window!=null?next.context_window
   :current.official_context_window!=null?current.context_window
   :current.context_window??next.context_window,
  input_modalities:currentOfficial?current.input_modalities
   :nextOfficial&&next.input_modalities?.length?next.input_modalities
   :next.input_modalities?.length?next.input_modalities
   :current.input_modalities,
  api_pricing:current.api_pricing??next.api_pricing,
  provider_pricing:current.provider_pricing??next.provider_pricing,
  reference_credits:current.reference_credits??next.reference_credits,
 };
 return merged;
}

export function buildAgentModelCatalog(sources:Array<{agent:string;providers:AgentProviderState[];modelConfigs?:AgentModelConfig[]}>):AgentModelCatalogEntry[]{
 const entries=new Map<string,AgentModelCatalogEntry>();
 for(const source of sources)for(const provider of source.providers){
  const baseUrl=fieldValue(provider,'baseUrl');
  const fields=Object.fromEntries(provider.fields.map(field=>[field.key,field.value??null]));
  const matchesProvider=(item:AgentModelConfig)=>item.provider===provider.id||provider.id==='native'&&(!item.provider||item.provider==='wanzhao');
  const configs=(source.modelConfigs??[]).filter(matchesProvider);
  const modelIds=[...new Set([...provider.models,...configs.map(item=>item.model)])];
  for(const model of modelIds){
   const config=configs.find(item=>item.model===model);
   const providerMetadata=providerModelMetadata(model,baseUrl,fields);
   const confirmedInputs=confirmedClaudeInputModalities(model);
   const confirmedWindow=confirmedClaudeContextWindow(model);
   if(confirmedInputs&&!providerMetadata.input_modalities?.length)providerMetadata.input_modalities=confirmedInputs;
   if(confirmedWindow&&!providerMetadata.official_context_window)providerMetadata.official_context_window=confirmedWindow;
   if(confirmedWindow&&!providerMetadata.context_window)providerMetadata.context_window=confirmedWindow;
   const metadata=mergeMetadata(config,providerMetadata);
   if(!hasOfficialModelMetadata(metadata)&&!confirmedClaudeInputModalities(model))continue;
   const canonical=canonicalModelName(model,metadata),vendor=modelVendor(canonical),key=`${vendor}\u0000${canonical}`;
   const current=entries.get(key);
   if(current){
    Object.assign(current,mergeMetadata(current,metadata));
    if(!current.providers.includes(provider.name))current.providers.push(provider.name);
   }else entries.set(key,{...metadata,vendor,model:canonical,providers:[provider.name]});
  }
 }
 return [...entries.values()].sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.model.localeCompare(b.model));
}

type StaticCatalogId=PublicApiCatalog|'deepseek';

interface StaticModelRecord {
 vendor:string;
 model:string;
 catalog?:StaticCatalogId;
 release_date?:string|null;
 context_window?:number;
 input_modalities?:string[];
 pricing?:ModelPricing;
}

interface StaticModelCatalog {
 version:string;
 last_updated:string;
 models:StaticModelRecord[];
}

function staticMetadata(record:StaticModelRecord):AgentModelMetadata {
 return {
  release_date:record.release_date??undefined,
  official_context_window:record.context_window,
  context_window:record.context_window,
  input_modalities:record.input_modalities,
  api_pricing:record.pricing?{...record.pricing,reference_only:false}:undefined,
 };
}

/** The hourly official snapshots are newer than the bundled baseline. Prefer
 * their confirmed fields while keeping the static record for values the
 * official document does not publish. */
function mergeFreshMetadata(base:AgentModelMetadata,fresh:AgentModelMetadata|undefined):AgentModelMetadata {
 if(!fresh)return base;
 const freshWindow=fresh.official_context_window??fresh.context_window;
 return {
  ...base,
  ...fresh,
  release_date:fresh.release_date??base.release_date,
  official_context_window:freshWindow??base.official_context_window,
  context_window:freshWindow??base.context_window,
  input_modalities:fresh.input_modalities?.length?fresh.input_modalities:base.input_modalities,
  api_pricing:fresh.api_pricing?{...fresh.api_pricing,reference_only:false}:base.api_pricing,
  provider_pricing:fresh.provider_pricing??base.provider_pricing,
  provider_billing:fresh.provider_billing??base.provider_billing,
  reference_credits:fresh.reference_credits??base.reference_credits,
  canonical_model:fresh.canonical_model??base.canonical_model,
 };
}

function officialStaticMetadata(record:StaticModelRecord):AgentModelMetadata|undefined {
 if(!record.catalog)return;
 if(record.catalog==='deepseek'){
  const official=deepseekCatalogModel(record.model);
  if(!official)return;
  return {
   ...official,
   official_context_window:official.context_window,
   api_pricing:official.api_pricing?{...official.api_pricing,reference_only:false}:undefined,
  };
 }
 const official=publicApiModel(record.catalog,record.model);
 if(!official)return;
 const metadata:AgentModelMetadata={...official};
 if(official.api_pricing)metadata.api_pricing={...official.api_pricing,reference_only:false};
 if(record.catalog==='claude'){
  const window=confirmedClaudeContextWindow(record.model);
  if(window!=null)metadata.official_context_window=metadata.context_window=window;
  const released=confirmedClaudeMetadata(record.model)?.release_date;
  if(released)metadata.release_date=released;
 }
 return metadata;
}

export async function loadStaticModelCatalog():Promise<AgentModelCatalogEntry[]>{
 try{
  const catalog=JSON.parse(await readFile(join(__dirname,'static-model-catalog.json'),'utf-8')) as StaticModelCatalog;
  if(!Array.isArray(catalog.models))return [];
  const entries=new Map<string,AgentModelCatalogEntry>();
  for(const record of catalog.models){
   if(!record||typeof record.vendor!=='string'||typeof record.model!=='string'||!record.vendor||!record.model)continue;
   let official:AgentModelMetadata|undefined;
   try{official=officialStaticMetadata(record);}catch{/* Keep the bundled baseline when the official snapshot is unavailable. */}
   const metadata=mergeFreshMetadata(staticMetadata(record),official);
   const model=metadata.canonical_model??record.model;
   entries.set(`${record.vendor}\u0000${model}`,{...metadata,vendor:record.vendor,model,providers:[]});
  }
  return [...entries.values()].sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.model.localeCompare(b.model));
 }catch(error){
  console.warn('Failed to load static model catalog:',error instanceof Error?error.message:error);
  return [];
 }
}

/** Dynamic entries describe currently configured Providers and may carry a
 * fresher official tariff. They win over the bundled baseline, while static
 * metadata and provider names are retained when the dynamic entry is silent. */
export function mergeCatalogEntries(base:AgentModelCatalogEntry,update:AgentModelCatalogEntry):AgentModelCatalogEntry {
 const providers=[...base.providers];
 for(const provider of update.providers)if(!providers.includes(provider))providers.push(provider);
 const officialWindow=update.official_context_window??base.official_context_window;
 const contextWindow=update.official_context_window!=null
  ?update.context_window??update.official_context_window
  :update.context_window??base.context_window;
 return {
  ...base,
  ...update,
  vendor:base.vendor,
  model:base.model,
  providers,
  release_date:update.release_date??base.release_date,
  official_context_window:officialWindow,
  context_window:contextWindow,
  input_modalities:update.input_modalities?.length?update.input_modalities:base.input_modalities,
  api_pricing:update.api_pricing?.reference_only===false?update.api_pricing:base.api_pricing??update.api_pricing,
  provider_pricing:update.provider_pricing??base.provider_pricing,
  provider_billing:update.provider_billing??base.provider_billing,
  reference_credits:update.reference_credits??base.reference_credits,
  canonical_model:update.canonical_model??base.canonical_model,
 };
}

export async function readAgentModelCatalog():Promise<AgentModelCatalogEntry[]>{
 const [staticEntries,dynamicSources]=await Promise.all([
  loadStaticModelCatalog(),
  Promise.all(agentDescriptors().map(async agent=>{
   const management=getAgent(agent.id).management;
   const [state,modelConfigs]=await Promise.all([
    management.inspect(false),
    management.readModelConfigs?.().catch(()=>[])??Promise.resolve([]),
   ]);
   return {agent:agent.id,providers:state.providers,modelConfigs};
  })),
 ]);
 const dynamicEntries=buildAgentModelCatalog(dynamicSources);
 const merged=new Map<string,AgentModelCatalogEntry>();
 for(const entry of staticEntries)merged.set(`${entry.vendor}\u0000${entry.model}`,entry);
 for(const entry of dynamicEntries){
  const key=`${entry.vendor}\u0000${entry.model}`;
  const current=merged.get(key);
  merged.set(key,current?mergeCatalogEntries(current,entry):entry);
 }
 return [...merged.values()].sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.model.localeCompare(b.model));
}
