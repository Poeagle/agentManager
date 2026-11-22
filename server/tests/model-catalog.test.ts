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

it('aggregates configured Provider models, de-duplicates same vendor/model, and enriches official DeepSeek data',()=>{
 const models=buildAgentModelCatalog([
  {agent:'claude',providers:[provider('deepseek-a','DeepSeek A',['deepseek-v4.1-flash'],'https://api.deepseek.com/v1')]},
  {agent:'codex',providers:[provider('deepseek-b','DeepSeek B',['deepseek-v4.1-flash','custom-model'],'https://gateway.example/v1')]},
 ]);
 expect(models).toHaveLength(2);
 expect(models.find(row=>row.model==='deepseek-v4.1-flash')).toMatchObject({
  vendor:'DeepSeek',providers:['DeepSeek A','DeepSeek B'],release_date:'2026-10-17',context_window:1_000_000,
  api_pricing:{currency:'CNY',reference_only:false},
 });
 expect(models.find(row=>row.model==='custom-model')).toMatchObject({vendor:'其他',providers:['DeepSeek B']});
});
