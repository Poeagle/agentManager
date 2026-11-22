import {afterEach,beforeEach,expect,it} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {initModelPricing} from '../src/services/agents/model-pricing.js';
import {buildAgentModelCatalog} from '../src/services/agents/model-catalog.js';
import type {AgentProviderState} from '../src/services/agents/types.js';

let fixture:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{fixture=createTestDatabase();initModelPricing();});
afterEach(()=>fixture.cleanup());

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
