import type {AgentModelMetadata,AgentModelPricing} from '../lib/api';

export function ModelPricing({pricing,credits,multiplier=1}: {
  pricing?:AgentModelPricing;
  credits?:AgentModelMetadata['reference_credits'];
  multiplier?:number;
}) {
  const amount=(rate:number|null|undefined)=>rate==null?'未提供':(rate*multiplier).toLocaleString('en-US',{maximumFractionDigits:8});
  if(credits)return <>Credits 每百万 Token<br/>输入 {credits.input} · 缓存 {credits.cached} · 输出 {credits.output}<br/><small>参考费率 {credits.as_of}，非实际账单</small></>;
  if(!pricing)return <>未提供</>;
  if(pricing.peak&&pricing.off_peak)return <span title={pricing.source}>
    {pricing.currency} / 百万 Token<br/><small>缓存命中 · 未命中 · 输出</small><br/>
    高峰 {amount(pricing.peak.cached)} · {amount(pricing.peak.input)} · {amount(pricing.peak.output)}<br/>
    空闲 {amount(pricing.off_peak.cached)} · {amount(pricing.off_peak.input)} · {amount(pricing.off_peak.output)}<br/>
    <small>北京时间工作日 {pricing.peak_hours?.map(hours=>hours.map(hour=>`${String(hour).padStart(2,'0')}:00`).join('–')).join('、')}，节假日除外</small>
  </span>;
  return <div title={pricing.source}>{pricing.currency} / 百万 Token
    {pricing.bands?.map(({label,rates},index)=><div key={label??index}>
      {label&&<small>{label}<br/></small>}
      输入 {amount(rates.input)} · 缓存命中 {amount(rates.cached)} · 输出 {amount(rates.output)}
      {rates.cache_write_5m!==undefined&&<><br/><small>缓存写入 5 分钟 {amount(rates.cache_write_5m)} · 1 小时 {amount(rates.cache_write_1h)}</small></>}
    </div>)}
  </div>;
}

export function modelMultiplierLabel(model?:AgentModelMetadata,providerMultiplier?:number) {
  const multiplier=model?.api_pricing?.provider_multiplier;
  if(model?.reference_credits||model?.api_pricing?.reference_only===false)return '1×';
  if(multiplier==null&&providerMultiplier!=null)return `${providerMultiplier.toLocaleString()}×`;
  return multiplier!=null?`${multiplier.toLocaleString()}×`:model?.api_pricing?.reference_only&&!model.provider_pricing?'未填写':'—';
}

export function modelCapabilitiesPayload(models:Array<AgentModelMetadata & {model:string}>):Record<string,string> {
  const rows=models.flatMap(({model,context_window,input_modalities})=>context_window||input_modalities?.length
    ? [[model,{context_window,input_modalities}]]:[]);
  return rows.length?{modelCapabilities:JSON.stringify(Object.fromEntries(rows))}:{};
}

export function modelImageLabel(inputs?:string[]) {
  return inputs?.length?inputs.includes('image')?'支持':'不支持':'未提供';
}
