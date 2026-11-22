import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {initModelPricing,pricingSources,refreshModelPricing} from '../src/services/agents/model-pricing.js';
import {buildAgentModelCatalog} from '../src/services/agents/model-catalog.js';
import type {AgentProviderState} from '../src/services/agents/types.js';

let fixture:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{fixture=createTestDatabase();initModelPricing();});
afterEach(()=>{vi.unstubAllGlobals();fixture.cleanup();});

function provider(id:string,name:string,models:string[],baseUrl:string):AgentProviderState{
 return {id,name,kind:'api',enabled:true,managed:true,status:'ready',statusText:'',authentication:{status:'authenticated',method:'API Key'},models,defaultModel:models[0]??null,
  fields:[{key:'baseUrl',label:'API 地址',type:'text',value:baseUrl}]} as AgentProviderState;
}

it('aggregates verified official models, de-duplicates same vendor/model, and omits opaque aliases',()=>{
 const models=buildAgentModelCatalog([
  {agent:'claude',providers:[provider('deepseek-a','DeepSeek A',['deepseek-v4.1-flash'],'https://api.deepseek.com/v1')]},
  {agent:'codex',providers:[provider('deepseek-b','DeepSeek B',['deepseek-v4.1-flash','custom-model'],'https://gateway.example/v1')]},
 ]);
 expect(models).toHaveLength(1);
 expect(models.find(row=>row.model==='deepseek-v4.1-flash')).toMatchObject({
  vendor:'DeepSeek',providers:['DeepSeek A','DeepSeek B'],release_date:'2026-10-17',context_window:1_000_000,
  api_pricing:{currency:'CNY',reference_only:false},
 });
 expect(models.find(row=>row.model==='custom-model')).toBeUndefined();
});

it('keeps official reference metadata from a gateway but excludes unregistered vendor IDs',()=>{
 const models=buildAgentModelCatalog([
  {agent:'claude',providers:[provider('gateway','Gateway',['claude-sonnet-5-5','private-alias'],'https://gateway.example/v1')]},
 ]);
 expect(models.map(row=>row.model)).toEqual(['claude-sonnet-5-5']);
});

it('does not treat an unknown model with a supplied capability as official',()=>{
 const models=buildAgentModelCatalog([
  {agent:'claude',providers:[provider('gateway','Gateway',['private-alias'],'https://gateway.example/v1')],modelConfigs:[{
   provider:'gateway',model:'private-alias',name:'Private',contextWindow:500000,maxContextWindow:500000,effectiveContextWindowPercent:100,
   inputModalities:['text','image'],supportsImages:true,sourceFile:null,
  }]},
 ]);
 expect(models).toEqual([]);
});

it('keeps confirmed official image capabilities when a gateway row has incomplete modalities',()=>{
 const models=buildAgentModelCatalog([
  {agent:'claude',providers:[provider('gateway','Gateway',['claude-sonnet-5-5'],'https://gateway.example/v1')],
   modelConfigs:[{provider:'gateway',model:'claude-sonnet-5-5',name:'Claude Sonnet 5.5',context_window:1_000_000,
    maxContextWindow:null,effectiveContextWindowPercent:null,inputModalities:[],supportsImages:false,sourceFile:null} as never]},
 ]);
 expect(models.find(row=>row.model==='claude-sonnet-5-5')).toMatchObject({
  input_modalities:['text','image'],context_window:1_000_000,
 });
});

it('keeps the confirmed Claude image capabilities across the current Provider model set',async()=>{
 const modelIds=[
  'claude-fable-5','claude-fable-5-1','claude-fable-5-2','claude-haiku-4-5','claude-haiku-4-5-20251001',
  'claude-haiku-5-5','claude-opus-4-5-20251101','claude-opus-4-6','claude-opus-4-7','claude-opus-4-8',
  'claude-opus-5','claude-opus-5-5','claude-sonnet-4-5-20250929','claude-sonnet-4-6','claude-sonnet-5','claude-sonnet-5-5',
 ];
 const pricing='| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |\n'+
  modelIds.map(model=>`| Claude ${model.replace(/^claude-/,'').replaceAll('-',' ')} | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |`).join('\n');
 await refreshModelPricing(vi.fn(async url=>String(url)===pricingSources.claude?new Response(pricing):new Response(null,{status:404})));
 const models=buildAgentModelCatalog([
  {agent:'claude',providers:[provider('anthropic','Anthropic',modelIds,'https://xindu.xyz')],
   modelConfigs:modelIds.map(model=>({provider:'anthropic',model,name:model,contextWindow:1_000_000,
    maxContextWindow:null,effectiveContextWindowPercent:null,inputModalities:[],supportsImages:false,sourceFile:null}))},
 ]);
 expect(models).toHaveLength(modelIds.length);
 expect(models.filter(row=>!row.input_modalities?.includes('image')).map(row=>[row.model,row.input_modalities])).toEqual([]);
});
