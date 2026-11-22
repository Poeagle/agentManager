import {agentDescriptors,getAgent} from './index.js';
import {providerModelMetadata} from './provider-pricing.js';
import {confirmedClaudeContextWindow,confirmedClaudeInputModalities} from './model-pricing.js';
import type {AgentModelConfig,AgentModelMetadata,AgentProviderState} from './types.js';

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

export async function readAgentModelCatalog():Promise<AgentModelCatalogEntry[]>{
 const sources=await Promise.all(agentDescriptors().map(async agent=>{
  const management=getAgent(agent.id).management;
  const [state,modelConfigs]=await Promise.all([
   management.inspect(false),
   management.readModelConfigs?.().catch(()=>[])??Promise.resolve([]),
  ]);
  return {agent:agent.id,providers:state.providers,modelConfigs};
 }));
 return buildAgentModelCatalog(sources);
}
