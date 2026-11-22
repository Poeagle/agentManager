import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {initModelPricing,parseHolidayNotice,pricingSnapshot,pricingSources,refreshModelPricing,estimatePublicApiCost,parseOfficialPricing} from '../src/services/agents/model-pricing.js';
import {deepseekModelPricing,estimateDeepseekCost} from '../src/services/agents/deepseek-pricing.js';
import {estimateUsageCredits,estimateUsageUsd} from '../src/services/agents/codex/usage-credits.js';
import {estimateProviderApiCost,modelRate,providerModelMetadata,providerRateFields,saveModelRates} from '../src/services/agents/provider-pricing.js';
import {codexApiEstimate,codexApiPricing} from '../src/services/agents/codex/statistics-cost.js';
import {updateAgentManagement,type StoredProvider} from '../src/services/agents/management-store.js';
import {probeProviderModels} from '../src/services/agents/codex/management.js';
import {confirmedClaudeInputModalities} from '../src/services/agents/model-pricing.js';

let fixture:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{fixture=createTestDatabase();initModelPricing();});
afterEach(()=>{vi.unstubAllGlobals();fixture.cleanup();});

const tokens={input_tokens:1_000_000,cached_input_tokens:500_000,output_tokens:100_000};
const model='deepseek-flash';
const epoch=(value:string)=>Date.parse(value);

it.each([
 ['2026-11-23T08:59:59+08:00',0.91],['2026-11-23T09:00:00+08:00',1.82],
 ['2026-11-23T12:00:00+08:00',0.91],['2026-11-23T14:00:00+08:00',1.82],
 ['2026-11-23T18:00:00+08:00',0.91],['2026-11-22T10:00:00+08:00',0.91],
 ['2027-02-08T10:00:00+08:00',0.91],['2027-02-22T10:00:00+08:00',1.82],
 ['2028-02-21T10:00:00+08:00',null],['2026-11-17T10:00:00+08:00',null],
])('prices a request observed at %s by its Beijing billing period',(at,expected)=>{
 expect(estimateDeepseekCost(model,epoch(at),tokens)).toBe(expected);
});

it('recognizes only confirmed Claude text-generation families as image-capable',()=>{
 expect(confirmedClaudeInputModalities('claude-fable-5')).toEqual(['text','image']);
 expect(confirmedClaudeInputModalities('claude-opus-4-5-20251101')).toEqual(['text','image']);
 expect(confirmedClaudeInputModalities('claude-opus-4-8')).toEqual(['text','image']);
 expect(confirmedClaudeInputModalities('claude-sonnet-4-5-20250929')).toEqual(['text','image']);
 expect(confirmedClaudeInputModalities('claude-sonnet-5-5[1m]')).toEqual(['text','image']);
 expect(confirmedClaudeInputModalities('private-gateway-model')).toBeUndefined();
});

it('provides official release dates and tariffs only for known models on the official URL',()=>{
 expect(deepseekModelPricing('https://api.deepseek.com/v1/',model)).toMatchObject({release_date:'2026-10-17',api_pricing:{currency:'CNY',peak:{input:2},off_peak:{input:1}}});
 expect(deepseekModelPricing('https://api.deepseek.com','deepseek-v4.1-flash')).toMatchObject({release_date:'2026-10-17',context_window:1_000_000,api_pricing:{peak:{input:2}}});
 expect(deepseekModelPricing('https://api.deepseek.com','deepseek-v4-pro')).toMatchObject({release_date:'2026-08-13',api_pricing:{peak:{input:9}}});
 for(const url of ['https://api.deepseek.com.proxy.test','http://api.deepseek.com','https://api.deepseek.com@proxy.test','https://api.deepseek.com/gateway','https://proxy.test/v1'])expect(deepseekModelPricing(url,model)).toBeNull();
 expect(deepseekModelPricing('https://api.deepseek.com','unknown-model')).toBeNull();
 expect(estimateDeepseekCost(model,epoch('2026-11-23T01:00:00Z'),{...tokens,cached_input_tokens:null})).toBeNull();
});

it('parses DeepSeek canonical model IDs, context lengths, and documented legacy aliases',()=>{
 const source=`| 模型 | 模型 | 模型 | deepseek-flash(1) | deepseek-v4-pro |
| 模型版本 | 模型版本 | 模型版本 | DeepSeek-V4.1-Flash-1017 | DeepSeek-V4-Pro-0813 |
| 上下文长度 | 上下文长度 | 上下文长度 | 1M | 1M |
| 价格(2) | 输入（缓存命中） | 高峰时段 | 0.04元 | 0.30元 |
| 价格(2) | 输入（缓存命中） | 空闲时段 | 0.02元 | 0.15元 |
| 价格(2) | 输入（缓存未命中） | 高峰时段 | 2元 | 9元 |
| 价格(2) | 输入（缓存未命中） | 空闲时段 | 1元 | 4.5元 |
| 价格(2) | 百万tokens输出 | 高峰时段 | 8元 | 27元 |
| 价格(2) | 百万tokens输出 | 空闲时段 | 4元 | 13.5元 |
北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段。
旧模型名 \`deepseek-v4.1-flash\` 按 Flash 价格计费。`;
 const data=parseOfficialPricing('deepseek',source);
 expect(data.models['deepseek-flash']).toMatchObject({context_window:1_000_000,release_date:'2026-10-17'});
 expect(data.models['deepseek-v4.1-flash']).toBe(data.models['deepseek-flash']);
 expect(data.models['deepseek-v4-pro']).toMatchObject({context_window:1_000_000,release_date:'2026-08-13'});
});

const deepseek=(input:number)=>`| 模型 | 模型 | 模型 | deepseek-flash(1) |
| 模型版本 | 模型版本 | 模型版本 | DeepSeek-V4.1-Flash-1017 |
| 价格(2) | 输入（缓存命中） | 高峰时段 | 0.04元 |
| 价格(2) | 输入（缓存命中） | 空闲时段 | 0.02元 |
| 价格(2) | 输入（缓存未命中） | 高峰时段 | ${input}元 |
| 价格(2) | 输入（缓存未命中） | 空闲时段 | 1元 |
| 价格(2) | 百万tokens输出 | 高峰时段 | 8元 |
| 价格(2) | 百万tokens输出 | 空闲时段 | 4元 |
北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段。`;

it('persists validated versions, preserves the previous tariff on bad documents and keeps units distinct',async()=>{
 const codex=`## Speed multipliers
| GPT-6.2 Sol | 2x | 2x |
## Credits
<table>Credits per 1M tokens<tr><td>GPT-6.2 Sol</td><td>50 credits</td><td>2.5 credits</td><td>250 credits</td></tr></table>`;
 const claude=`| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |`;
 const openai='### Standard pricing data\n| gpt-6.2-sol | $2 | $10 | $0.10 |';
 const documents:Record<string,string>={[pricingSources.codex]:codex,[pricingSources.claude]:claude,[pricingSources.openai]:openai,[pricingSources.deepseek]:deepseek(2)};
 const fetcher=vi.fn<typeof fetch>(async url=>new Response(documents[String(url)]??'',{headers:{'content-type':'text/plain'}}));
 const first=epoch('2026-11-23T01:00:00Z'),second=first+3600000;
 await refreshModelPricing(fetcher,undefined,first);
 expect(estimateUsageCredits('gpt-6.2-sol','fast',tokens)).toBe(102.5);
 expect(estimateUsageUsd('gpt-6.2-sol','standard',tokens)).toBe(2.05);
 expect(estimateUsageUsd('gpt-6.2-sol','fast',tokens)).toBe(4.1);
 expect(estimateUsageUsd('unpriced-model','standard',tokens)).toBeNull();
 expect(estimatePublicApiCost('openai','gpt-6.2-sol',new Date(first).toISOString(),tokens)).toMatchObject({amount:2.05,breakdown:{input:1,cache:0.05,output:1,reasoning:null}});
 const claudeCost=estimatePublicApiCost('claude','claude-sonnet-5-5',new Date(first).toISOString(),tokens,[100_000,100_000]);
 expect(claudeCost?.amount).toBeCloseTo(2.3);
 expect(claudeCost?.breakdown).toMatchObject({input:1.25,cache:0.05,output:1,reasoning:null});
 documents[pricingSources.deepseek]=deepseek(4);
 await refreshModelPricing(fetcher,undefined,second);
 documents[pricingSources.deepseek]='upstream error';
 await refreshModelPricing(fetcher,undefined,second+3600000);
 initModelPricing();
 expect(pricingSnapshot('deepseek')?.checked).toBe(second);
 expect(estimateDeepseekCost(model,first,tokens)).toBe(1.82);
 expect(estimateDeepseekCost(model,second,tokens)).toBeCloseTo(2.82,10);
});

it('parses full holiday ranges without treating compensatory workdays as holidays',()=>{
 const notice='<title>国务院办公厅关于2027年部分节假日安排的通知</title><b>一、</b>元旦：1月1日（周五）至3日（周日）放假。二、春节：2月5日至2月13日放假。三、清明节：4月3日至5日放假。四、劳动节：5月1日至5日放假。五、端午节：6月9日放假。六、中秋节：9月15日放假。七、国庆节：10月1日至7日放假，10月9日上班。';
 expect(parseHolidayNotice(2027,notice)).toEqual([['01-01','01-03'],['02-05','02-13'],['04-03','04-05'],['05-01','05-05'],['06-09','06-09'],['09-15','09-15'],['10-01','10-07']]);
 expect(()=>parseHolidayNotice(2028,notice)).toThrow();
});

it('prices only the exact gateway model and applies the rate effective at the receipt time',async()=>{
 const model='gpt-6.2-sol';
 const ratesAt=epoch('2026-11-23T01:00:00Z');
 const first=ratesAt+1000,second=first+1000;
 const receiptAt=(at:number)=>new Date(at).toISOString();
 const baseUrl='https://gateway.example/v1';
 const fetcher=vi.fn<typeof fetch>(async url=>String(url)===pricingSources.openai?new Response(
   '### Standard pricing data\n| gpt-6.2-sol | $2 | $10 | $0.10 |'):new Response(null,{status:404}));
 await refreshModelPricing(fetcher,undefined,ratesAt);
 const fields:StoredProvider['fields']={baseUrl,modelRateMultipliers:[`${model}=1.2`]};
 saveModelRates(fields,undefined,first);
 const updated={...fields,modelRateMultipliers:[`${model}=1.5`]};
 saveModelRates(updated,fields,second);
 expect(modelRate(updated,model)).toBe(1.5);
 expect(estimateProviderApiCost(baseUrl,updated,model,receiptAt(first-1),tokens)?.amount).toBeCloseTo(2.05);
 expect(estimateProviderApiCost(baseUrl,updated,'unknown-model',receiptAt(first),tokens)).toBeNull();
 const estimate=estimateProviderApiCost(baseUrl,updated,model,receiptAt(first),tokens);
 expect(estimate?.amount).toBeCloseTo(2.46,10);
 expect(estimate?.breakdown).toEqual({input:1.2,cache:0.06,output:1.2,reasoning:null});
 expect(estimateProviderApiCost(baseUrl,updated,model,receiptAt(second),tokens)?.amount).toBeCloseTo(3.075,10);
 updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'gateway',name:'Gateway',kind:'responses',enabled:true,fields:updated}]}));
 const binding=codexApiPricing('provider:gateway')!;
 expect(codexApiEstimate(binding,'gateway',model,'default',receiptAt(first),tokens).amount).toBeCloseTo(2.46,10);
 expect(codexApiEstimate(binding,'other',model,'default',receiptAt(first),tokens).amount).toBeNull();
 expect(codexApiEstimate(binding,'gateway',model,'priority',receiptAt(first),tokens).amount).toBeNull();
 expect(()=>saveModelRates({baseUrl,modelRateMultipliers:[`${model}=0`]},updated,second+1)).toThrow('模型计费倍率');
 const removed={...updated,modelRateMultipliers:[]};
 saveModelRates(removed,updated,second+1);
 expect(modelRate(removed,model)).toBeUndefined();
 expect(modelRate(removed,model,first)).toBe(1.2);
});

it('uses a single gateway rate for every fallback model at the time of the receipt',()=>{
 const baseUrl='https://gateway.example/v1';
 const first=epoch('2026-11-23T01:00:00Z'), second=first+1000, third=second+1000;
 const legacy:StoredProvider['fields']={baseUrl,modelRateMultipliers:[`${model}=1.5`]};
 saveModelRates(legacy,undefined,first);
 const shared={...legacy,providerRateMultiplier:'1.2'};
 saveModelRates(shared,legacy,second);
 expect(modelRate(shared,model,second-1)).toBe(1.5);
 expect(modelRate(shared,model,second)).toBe(1.2);
 expect(modelRate(shared,'another-model',second)).toBe(1.2);
 expect(providerModelMetadata(model,baseUrl,shared).api_pricing?.provider_multiplier).toBe(1.2);
 expect(estimateProviderApiCost(baseUrl,shared,model,new Date(second).toISOString(),tokens)?.amount).toBeCloseTo(1.82*1.2);
 expect(estimateProviderApiCost('https://api.deepseek.com',shared,model,new Date(second).toISOString(),tokens)?.amount).toBeCloseTo(1.82);
 const cleared={...shared,providerRateMultiplier:''};
 saveModelRates(cleared,shared,third);
 expect(modelRate(cleared,model,third)).toBeUndefined();
 expect(modelRate(cleared,model,second)).toBe(1.2);
 expect(()=>saveModelRates({...shared,providerRateMultiplier:'0'},shared,third)).toThrow('Provider 计费倍率');
});

it('keeps Sub2API billing automatic until an explicit manual multiplier replaces it',()=>{
 const baseUrl='https://xindu.xyz/v1',at=epoch('2026-11-23T01:00:00Z');
 const automatic:StoredProvider['fields']={baseUrl,providerRateMultiplier:'0.42',providerRateSource:'sub2api',
  providerBillingSnapshot:JSON.stringify({source:'sub2api',observedAt:at,resolvedRate:0.42,effectiveRate:0.42,peakEnabled:false})};
 const same=structuredClone(automatic);
 saveModelRates(same,automatic,at+1000);
 expect(same).toMatchObject({providerRateMultiplier:'0.42',providerRateSource:'sub2api'});
 expect(providerRateFields(baseUrl,same)[0]).toMatchObject({label:'Provider 自动倍率（可手动覆盖）'});

 const manual={...automatic,providerRateMultiplier:'0.75'};
 saveModelRates(manual,automatic,at+2000);
 expect(manual).toMatchObject({providerRateMultiplier:'0.75',modelRateVersions:expect.any(String)});
 expect(manual.providerRateSource).toBeUndefined();
 expect(manual.providerBillingSnapshot).toBeUndefined();
 expect(modelRate(manual,model,at+2000)).toBe(0.75);
 expect(providerRateFields(baseUrl,manual)[0]).not.toHaveProperty('readOnly');
});

it.each([false,true])('recovers historical context thresholds only when both tariff tiers match (price changed: %s)',async(changed)=>{
 const before=epoch('2026-11-22T05:17:43Z');
 const request='2026-11-22T06:28:14.688Z';
 const after=epoch('2026-11-22T07:00:41Z');
 const row=(longInput:string)=>`### Standard pricing data
| gpt-6.2-sol | $2 | $10 | $0.10 | $2.50 | $5 | ${longInput} | $15 | $0.20 |`;
 let document=row('$4');
 const fetcher:typeof fetch=async url=>String(url)===pricingSources.openai?new Response(document):new Response(null,{status:404});
 await refreshModelPricing(fetcher,undefined,before);
 document=row(changed?'$5':'$4')+'\n\nLong context: >272K input tokens.';
 await refreshModelPricing(fetcher,undefined,after);
 const use=(input_tokens:number)=>({input_tokens,cached_input_tokens:3564,output_tokens:1000});
 const estimate=(input:number)=>estimateProviderApiCost('https://gateway.example/v1',undefined,'gpt-6.2-sol',request,use(input));
 if(changed){expect(estimate(100075)).toBeNull();return;}
 expect(estimate(100075)?.breakdown.input).toBeCloseTo(0.193022);
 expect(estimate(100075)?.breakdown.cache).toBeCloseTo(0.0003564);
 expect(estimate(272000)?.breakdown.input).toBeCloseTo(0.536872);
 expect(estimate(272001)?.breakdown.input).toBeCloseTo(1.073748);
});

it('syncs official model metadata and applies provider rates before the manual multiplier fallback',async()=>{
 const model='gpt-6.2-sol',routerModel=`openai/${model}`;
 const now=epoch('2026-11-22T00:00:00Z'),at=new Date(now).toISOString();
 const documents:Record<string,string>={
  [pricingSources.openai]:'### Standard pricing data\n| gpt-6.2-sol | $2 | $10 | $0.10 | $2.50 | $5 | $4 | $15 | $0.20 |\n\nLong context: >272K input tokens.',
  'https://developers.openai.com/api/docs/changelog.md':'## November, 2026\n### Nov 17\nFeature · Model: gpt-6.2-sol · API: v1/responses',
  'https://developers.openai.com/api/docs/models/gpt-6.2-sol.md':'## Model details\n- Input modalities: text, image\n- 1,050,000 context window',
  [pricingSources.openrouter]:JSON.stringify({data:[{id:routerModel,context_length:500000,pricing:{prompt:'0.000003',completion:'0.000009',input_cache_read:'0.0000005'}}]}),
  [pricingSources.xai]:'### Text API Pricing\n| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |\n| grok-4.7 (≥ 200k prompt tokens) | 500k | $4.00 | $1.00 | $12.00 |',
 };
 const fetcher:typeof fetch=async url=>new Response(documents[String(url)]??'',{status:Object.hasOwn(documents,String(url))?200:404});
 await refreshModelPricing(fetcher,undefined,now);
 const official='https://api.openai.com/v1',gateway='https://gateway.example/v1',router='https://openrouter.ai/api/v1';
 expect(pricingSnapshot('openai')?.data.models[model]).toMatchObject({bands:[
  {label:'≤ 272K 输入 Token',min_input_tokens:0,rates:{input:2,cached:0.1,output:10}},
  {label:'> 272K 输入 Token',min_input_tokens:272001,rates:{input:4,cached:0.2,output:15}},
 ]});
 const fields:StoredProvider['fields']={baseUrl:gateway,modelRateMultipliers:[`${model}=1.2`,`${routerModel}=1.5`]};
 saveModelRates(fields,undefined,now);
 const usage=(input_tokens:number)=>({input_tokens,cached_input_tokens:0,output_tokens:1000});
 expect(providerModelMetadata(model,gateway,fields)).toMatchObject({release_date:'2026-11-17',official_context_window:1050000,api_pricing:{reference_only:true,provider_multiplier:1.2}});
 expect(providerModelMetadata(routerModel,router,fields)).toMatchObject({release_date:'2026-11-17',official_context_window:1050000,context_window:500000,provider_pricing:{bands:[{rates:{input:3}}]}});
 expect(providerModelMetadata(routerModel,router,fields).api_pricing?.provider_multiplier).toBeUndefined();
 expect(estimateProviderApiCost(official,fields,model,at,usage(272000))?.amount).toBeCloseTo(0.554);
 expect(estimateProviderApiCost(official,fields,model,at,usage(272001))?.amount).toBeCloseTo(1.103004);
 expect(estimateProviderApiCost(gateway,fields,model,at,usage(272001))?.amount).toBeCloseTo(1.103004*1.2);
 expect(estimateProviderApiCost(router,fields,routerModel,at,usage(272001))?.amount).toBeCloseTo(0.825003);
 const routerFields={baseUrl:router,providerRateMultiplier:'2'};
 saveModelRates(routerFields,undefined,now);
 expect(estimateProviderApiCost(router,routerFields,routerModel,at,usage(272001))?.amount).toBeCloseTo(0.825003);
 expect(providerModelMetadata(routerModel,router,routerFields).api_pricing?.provider_multiplier).toBeUndefined();
 expect(estimateProviderApiCost('https://openrouter.ai.example/api/v1',fields,routerModel,at,usage(272001))?.amount).toBeCloseTo(1.103004*1.5);
 expect(providerModelMetadata('grok-4.7',gateway)).toMatchObject({release_date:'2026-09-21',official_context_window:500000});
 expect(estimateProviderApiCost('https://api.x.ai/v1',undefined,'grok-4.7',at,usage(199999))?.amount).toBeCloseTo(0.405998);
 expect(estimateProviderApiCost(gateway,undefined,'grok-4.7',at,usage(200000))?.amount).toBeCloseTo(0.812);
 expect(estimateProviderApiCost(gateway,undefined,'grok-4.7-build-fast',at,usage(200000))).toBeNull();
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[
  {id:model},
  {id:'custom',context_length:120000,architecture:{input_modalities:['text']}},
  {id:'unknown',context_window:-10,input_modalities:['INVALID']},
 ]})));
 const models=await probeProviderModels(gateway,'fixture-key');
 expect(models).toMatchObject([
  {model,context_window:1050000,input_modalities:['text','image']},
  {model:'custom',context_window:120000,input_modalities:['text']},
  {model:'unknown',context_window:undefined,input_modalities:undefined},
 ]);
});
