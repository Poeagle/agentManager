import {pricingSnapshot,publishedHolidays,tokenPriceBreakdown} from './model-pricing.js';

export const deepseekOrigin='https://api.deepseek.com';
const timezone='Asia/Shanghai';
const peakHours=[[9,12],[14,18]];
const source='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const peakFlash={cached:0.04,input:2,output:8};
const peakPro={cached:0.30,input:9,output:27};

// Published State Council holiday periods for cold starts without network access.
const holidayFallback:Record<number,string[][]>={
 2026:[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']],
 2027:[['01-01','01-03'],['02-05','02-13'],['04-03','04-05'],['05-01','05-05'],['06-09','06-09'],['09-15','09-15'],['10-01','10-07']],
};

export function isOfficialDeepSeek(baseUrl:unknown):boolean {
 if(typeof baseUrl!=='string')return false;
 try{
  const url=new URL(baseUrl);
  return url.origin===deepseekOrigin&&!url.username&&!url.password&&!url.search&&!url.hash&&['','/v1','/anthropic'].includes(url.pathname.replace(/\/+$/,''));
 }catch{return false;}
}

function modelTariff(model:string|null,at=Infinity){
 const synced=pricingSnapshot('deepseek',at)?.data;
 if(synced){
  const id=canonicalDeepSeekModel(model);
  const tariff=id&&Object.hasOwn(synced.models,id)?synced.models[id]:null;
  return tariff&&{release_date:tariff.release_date,context_window:tariff.context_window,peak:tariff.bands[0].rates,off_peak:tariff.bands[1].rates,peak_hours:synced.peak_hours??peakHours};
 }
 const preset=initialTariff(model);
 if(!preset)return null;
 const {peak}=preset;
 return {...preset,off_peak:{cached:peak.cached/2,input:peak.input/2,output:peak.output/2},peak_hours:peakHours};
}

function initialTariff(model:string|null){
 model=canonicalDeepSeekModel(model);
 switch(model){
  case 'deepseek-flash':case 'deepseek-v4-flash':case 'deepseek-v4-flash-vision-exp':
   return {release_date:'2026-10-17',context_window:1_000_000,peak:peakFlash};
  case 'deepseek-v4-pro':
   return {release_date:'2026-08-13',context_window:1_000_000,peak:peakPro};
  default:return null;
 }
}

function canonicalDeepSeekModel(model:string|null){
 if(model==='deepseek-v4.1-flash')return 'deepseek-flash';
 return model;
}

export function deepseekModelPricing(baseUrl:unknown,model:string){
 if(!isOfficialDeepSeek(baseUrl))return null;
 return deepseekCatalogModel(model);
}

export function deepseekCatalogModel(model:string){
 const tariff=modelTariff(model);
 if(!tariff)return null;
 const {release_date,peak,off_peak,peak_hours}=tariff;
 return {release_date:release_date??null,context_window:tariff.context_window,api_pricing:{currency:'CNY' as const,peak,off_peak,timezone,peak_hours,source}};
}

// The timestamp in the ledger is an observed response timestamp. Beijing uses UTC+08.
function beijingTime(epoch:number){return new Date(epoch+8*3600000);}
export function deepseekDay(epoch:number){return beijingTime(epoch).toISOString().slice(0,10);}

// Bound estimates to the verified pricing period. Earlier model IDs could route to a different tariff.
const verifiedFrom=Date.parse('2026-11-18T12:00:00+08:00');
export function estimateDeepseekBreakdown(model:string|null,epoch:number,tokens:Record<string,number|null>){
 if(!Number.isFinite(epoch)||epoch<verifiedFrom)return null;
 const tariff=modelTariff(model,epoch);
 if(!tariff)return null;
 const at=beijingTime(epoch),hour=at.getUTCHours(),weekday=at.getUTCDay();
 const duringPeakHours=weekday>=1&&weekday<=5&&tariff.peak_hours.some(([start,end])=>hour>=start&&hour<end);
 const year=at.getUTCFullYear(),holidays=publishedHolidays(year)??holidayFallback[year];
 if(duringPeakHours&&!holidays)return null;
 const date=at.toISOString().slice(5,10);
 const peak=duringPeakHours&&!holidays?.some(([start,end])=>date>=start&&date<=end);
 return tokenPriceBreakdown(tokens,peak?tariff.peak:tariff.off_peak);
}

export function estimateDeepseekCost(model:string|null,epoch:number,tokens:Record<string,number|null>):number|null{
 const cost=estimateDeepseekBreakdown(model,epoch,tokens);
 return cost?cost.input+cost.cache+cost.output:null;
}
