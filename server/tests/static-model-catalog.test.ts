import {describe,expect,it} from 'vitest';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname,join} from 'path';

const __dirname=dirname(fileURLToPath(import.meta.url));
const catalogPath=join(__dirname,'../src/services/agents/static-model-catalog.json');
const allowedCatalogs=new Set(['openai','claude','deepseek','kimi','xai','gemini','glm']);
const expectedModels=[
 'gpt-6.2-sol','gpt-6.2-astra','gpt-6.1-sol','gpt-6.1-terra',
 'claude-fable-5-2','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5','claude-opus-5','claude-sonnet-5',
 'deepseek-flash','deepseek-v4-pro','kimi-k3.1-pro','kimi-k3','grok-4.7',
 'gemini-4-carbon','gemini-4-argon','gemini-4-neon','gemini-4-hydrogen','gemini-3.5-flash-lite',
 'glm-5.3','glm-5.3-flash',
];
const legacyModels=['deepseek-v4.1-flash','grok-4.8','gemini-3.0-pro','gemini-3.0-flash','glm-5-plus','glm-5-flash','kimi-k3.1'];

function catalog(){
 return JSON.parse(readFileSync(catalogPath,'utf-8')) as {
  version:string;last_updated:string;
  models:Array<{
   vendor:string;model:string;catalog:string;release_date?:string;context_window?:number;
   input_modalities?:string[];pricing?:{
    currency:string;source:string;bands?:Array<{min_input_tokens?:number;label?:string;rates:{input:number;cached:number|null;output:number}}>;
    peak?:{input:number;cached:number|null;output:number};off_peak?:{input:number;cached:number|null;output:number};
   };
  }>;
 };
}

describe('bundled official model catalog',()=>{
 it('lists the current common models for every supported vendor and no superseded IDs',()=>{
  const data=catalog();
  expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(data.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(new Set(data.models.map(model=>model.model))).toEqual(new Set(expectedModels));
  for(const legacy of legacyModels)expect(data.models.some(model=>model.model===legacy)).toBe(false);
 });

 it('keeps every record verifiable, uniquely keyed, and priced from an official source',()=>{
  const data=catalog(),keys=new Set<string>();
  for(const model of data.models){
   expect(model.vendor).toBeTruthy();
   expect(model.model).toBeTruthy();
   expect(allowedCatalogs.has(model.catalog)).toBe(true);
   const key=`${model.vendor}:${model.model}`;
   expect(keys.has(key)).toBe(false);
   keys.add(key);
   if(model.release_date)expect(model.release_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
   if(model.context_window!==undefined)expect(Number.isSafeInteger(model.context_window)&&model.context_window>0).toBe(true);
   if(model.input_modalities)expect(model.input_modalities.every(value=>typeof value==='string'&&value.length>0)).toBe(true);
   expect(model.pricing).toBeDefined();
   const pricing=model.pricing!;
   expect(pricing.currency).toMatch(/^[A-Z]{3}$/);
   expect(pricing.source).toMatch(/^https:\/\//);
   const bands=pricing.bands??[];
   if(bands.length){
    for(const band of bands){
     if(band.min_input_tokens!==undefined)expect(Number.isSafeInteger(band.min_input_tokens)&&band.min_input_tokens>=0).toBe(true);
     expect(band.rates.input).toBeGreaterThanOrEqual(0);
     expect(band.rates.output).toBeGreaterThanOrEqual(0);
     expect(band.rates.cached===null||band.rates.cached>=0).toBe(true);
    }
   }else{
    expect(pricing.peak).toBeDefined();
    expect(pricing.off_peak).toBeDefined();
   }
  }
 });

 it('keeps the verified long-context tiers and vendor-specific rates',()=>{
  const models=catalog().models;
  const gpt=models.find(model=>model.model==='gpt-6.2-sol')!;
  expect(gpt.context_window).toBe(1_050_000);
  expect(gpt.pricing?.bands?.map(band=>[band.min_input_tokens,band.rates])).toEqual([
   [0,{input:2,cached:0.1,output:10}],
   [272_001,{input:4,cached:0.2,output:15}],
  ]);
  expect(models.find(model=>model.model==='claude-haiku-5-5')).toMatchObject({
   release_date:'2026-10-07',context_window:1_000_000,
   pricing:{bands:[{min_input_tokens:0},{min_input_tokens:100_001}]},
  });
  expect(models.find(model=>model.model==='grok-4.7')?.context_window).toBe(500_000);
  expect(models.find(model=>model.model==='deepseek-flash')?.pricing).toMatchObject({
   currency:'CNY',peak:{cached:0.04},off_peak:{cached:0.02},
  });
  expect(models.find(model=>model.model==='kimi-k3.1-pro')).toMatchObject({
   release_date:'2026-10-23',context_window:1_048_576,
  });
  expect(models.find(model=>model.model==='gemini-4-neon')).toMatchObject({
   release_date:'2026-11-18',context_window:1_048_576,
  });
  expect(models.find(model=>model.model==='glm-5.3')?.release_date).toBe('2026-08-18');
 });
});
