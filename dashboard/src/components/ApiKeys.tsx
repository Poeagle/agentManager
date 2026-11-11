import {useEffect,useState} from 'react';
import {fetchJSON,type MyPermissions,type PermissionGrants,type PermissionLevel} from '../lib/api';

type KeyRecord={id:string;name:string;created_at:string;expires_at:string;last_used_at:string|null;grants:PermissionGrants};
const rank:Record<PermissionLevel,number>={read:1,write:2,delete:3};
const labels:Record<PermissionLevel,string>={read:'读取',write:'读写',delete:'读写及删除'};
function tomorrow(){const d=new Date(Date.now()+86400000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}

export function ApiKeys({permissions}:{permissions:MyPermissions}){
  const [keys,setKeys]=useState<KeyRecord[]>([]),[name,setName]=useState(''),[expires,setExpires]=useState(tomorrow);
  const [grants,setGrants]=useState<PermissionGrants>({});
  const [secret,setSecret]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=async()=>{const result=await fetchJSON<{keys:KeyRecord[]}>('/auth/api-keys');setKeys(result.keys);};
  useEffect(()=>{void load().catch(e=>setError(e instanceof Error?e.message:'读取失败'));},[]);
  const create=async(e:React.FormEvent)=>{e.preventDefault();setError('');setBusy(true);try{
    const date=new Date(expires);if(!Number.isFinite(date.getTime()))throw Error('请选择有效到期时间');
    const result=await fetchJSON<{key:string;record:KeyRecord}>('/auth/api-keys',{method:'POST',body:JSON.stringify({name,expires_at:date.toISOString(),grants})});
    setSecret(result.key);setKeys(current=>[result.record,...current]);setName('');
  }catch(e){setError(e instanceof Error?e.message:'创建失败');}finally{setBusy(false);}};
  const revoke=async(id:string)=>{setError('');try{await fetchJSON(`/auth/api-keys/${encodeURIComponent(id)}`,{method:'DELETE'});setKeys(current=>current.filter(k=>k.id!==id));}catch(e){setError(e instanceof Error?e.message:'撤销失败');}};
  const input='min-w-0 rounded border px-2 py-1.5 text-sm';
  return <section className="mt-7 flex flex-col gap-3" aria-labelledby="api-keys-title">
    <h3 id="api-keys-title" className="text-sm font-medium">API Key</h3>
    <p className="text-xs" style={{color:'var(--text-secondary)'}}>选择权限和到期时间；实际权限不超过账号当前权限。密钥仅在创建时显示。Agent API 包括会话、文件和 Git 等操作；管理 Engine 需要平台设置和 Agent API 权限。</p>
    <form onSubmit={create} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs">名称<input className={input} value={name} maxLength={80} required onChange={e=>setName(e.target.value)} /></label>
      <label className="flex flex-col gap-1 text-xs">到期时间<input className={input} type="datetime-local" required value={expires} onChange={e=>setExpires(e.target.value)} /></label>
      <fieldset className="flex w-full flex-wrap gap-3"><legend className="mb-1 text-xs">授权范围</legend>{permissions.catalog.filter(item=>permissions.permissions[item.key]).map(item=><label key={item.key} className="flex flex-col gap-1 text-xs">{item.label}<select className={input} value={grants[item.key]||''} onChange={e=>setGrants(current=>{const next={...current};if(e.target.value)next[item.key]=e.target.value as PermissionLevel;else delete next[item.key];return next;})}><option value="">不授权</option>{item.levels.filter(level=>rank[level]<=rank[permissions.permissions[item.key]!]).map(level=><option key={level} value={level}>{labels[level]}</option>)}</select></label>)}</fieldset>
      <button type="submit" disabled={busy||!name.trim()||!Object.keys(grants).length} className="rounded px-3 py-1.5 text-sm disabled:opacity-50" style={{background:'var(--accent)',color:'white'}}>创建</button>
    </form>
    {secret&&<div className="flex flex-wrap items-center gap-2 text-xs" role="status"><span>请立即保存，关闭后无法再次查看：</span><code className="break-all select-all">{secret}</code><button type="button" className="underline" onClick={()=>setSecret('')}>关闭</button></div>}
    {error&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>{error}</p>}
    {keys.map(key=><div key={key.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b py-2 text-xs" style={{borderColor:'var(--border)'}}><strong>{key.name}</strong><span>{Object.entries(key.grants).map(([id,level])=>`${permissions.catalog.find(item=>item.key===id)?.label||id}：${level?labels[level]:''}`).join('、')}</span><span>{Date.parse(key.expires_at)<=Date.now()?'已过期':'到期'}：{new Date(key.expires_at).toLocaleString()}</span><span>最近使用：{key.last_used_at?new Date(key.last_used_at).toLocaleString():'从未使用'}</span><button type="button" className="ml-auto underline" onClick={()=>void revoke(key.id)}>撤销</button></div>)}
  </section>;
}
