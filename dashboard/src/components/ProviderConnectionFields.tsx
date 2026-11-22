import type {ReactNode} from 'react';

export function ProviderConnectionFields({id,name,endpoint,apiKey,configured,disabled,endpointLabel='API 地址',endpointHint,labelPrefix='',onChange}: {
  id?:string;name:string;endpoint:string;apiKey:string;configured?:boolean;disabled?:boolean;
  endpointLabel?:string;endpointHint?:string;labelPrefix?:string;
  onChange:(field:'id'|'name'|'endpoint'|'apiKey',value:string)=>void;
}) {
  return <div className="provider-connection-fields">
    {id!==undefined&&<label className="agent-management-field"><span>Provider ID<b>*</b></span><input aria-label={`${labelPrefix}Provider ID`} value={id} disabled={disabled} onChange={event=>onChange('id',event.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g,''))}/></label>}
    <label className="agent-management-field"><span>显示名称</span><input aria-label={labelPrefix?`${labelPrefix}Provider 名称`:'显示名称'} value={name} disabled={disabled} onChange={event=>onChange('name',event.target.value)}/></label>
    <label className="agent-management-field" title={endpointHint}><span>{endpointLabel}<b>*</b></span><input aria-label={`${labelPrefix}${endpointLabel}`} title={endpointHint} inputMode="url" value={endpoint} disabled={disabled} onChange={event=>onChange('endpoint',event.target.value)}/></label>
    <label className="agent-management-field"><span>API Key{configured&&<small className="agent-management-configured">已配置</small>}{id!==undefined&&<b>*</b>}</span><input aria-label={`${labelPrefix}API Key`} type="password" autoComplete="new-password" value={apiKey} placeholder={configured?'留空保持不变':'输入 API Key'} disabled={disabled} onChange={event=>onChange('apiKey',event.target.value)}/></label>
  </div>;
}

export function ProviderAdvancedSettings({label,children}:{label:string;children:ReactNode}) {
  return <details className="provider-advanced-settings"><summary>{label}</summary>{children}</details>;
}

export function ProviderRateSettings({value,disabled,onChange,label='模型计费倍率'}:{value:string;disabled?:boolean;onChange:(value:string)=>void;label?:string}) {
  return <ProviderAdvancedSettings label="手填计费倍率">
    <label className="agent-management-field"><span>模型计费倍率</span><textarea aria-label={label} rows={2} value={value} placeholder="模型 ID=1.2" disabled={disabled} onChange={event=>onChange(event.target.value)}/></label>
  </ProviderAdvancedSettings>;
}
