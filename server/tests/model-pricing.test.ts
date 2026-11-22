import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {initModelPricing,parseHolidayNotice,pricingSnapshot,pricingSources,refreshModelPricing,estimatePublicApiCost} from '../src/services/agents/model-pricing.js';
import {deepseekModelPricing,estimateDeepseekCost} from '../src/services/agents/codex/deepseek-pricing.js';
import {estimateUsageCredits} from '../src/services/agents/codex/usage-credits.js';

let fixture:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{fixture=createTestDatabase();initModelPricing();});
afterEach(()=>{fixture.cleanup();});

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

it('provides official release dates and tariffs only for known models on the official URL',()=>{
 expect(deepseekModelPricing('https://api.deepseek.com/v1/',model)).toMatchObject({release_date:'2026-10-17',api_pricing:{currency:'CNY',peak:{input:2},off_peak:{input:1}}});
 expect(deepseekModelPricing('https://api.deepseek.com','deepseek-v4-pro')).toMatchObject({release_date:'2026-08-13',api_pricing:{peak:{input:9}}});
 for(const url of ['https://api.deepseek.com.proxy.test','http://api.deepseek.com','https://api.deepseek.com@proxy.test','https://api.deepseek.com/gateway','https://proxy.test/v1'])expect(deepseekModelPricing(url,model)).toBeNull();
 expect(deepseekModelPricing('https://api.deepseek.com','unknown-model')).toBeNull();
 expect(estimateDeepseekCost(model,epoch('2026-11-23T01:00:00Z'),{...tokens,cached_input_tokens:null})).toBeNull();
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
 expect(estimateDeepseekCost(model,second,tokens)).toBe(2.82);
});

it('parses full holiday ranges without treating compensatory workdays as holidays',()=>{
 const notice='<title>国务院办公厅关于2027年部分节假日安排的通知</title><b>一、</b>元旦：1月1日（周五）至3日（周日）放假。二、春节：2月5日至2月13日放假。三、清明节：4月3日至5日放假。四、劳动节：5月1日至5日放假。五、端午节：6月9日放假。六、中秋节：9月15日放假。七、国庆节：10月1日至7日放假，10月9日上班。';
 expect(parseHolidayNotice(2027,notice)).toEqual([['01-01','01-03'],['02-05','02-13'],['04-03','04-05'],['05-01','05-05'],['06-09','06-09'],['09-15','09-15'],['10-01','10-07']]);
 expect(()=>parseHolidayNotice(2028,notice)).toThrow();
});
