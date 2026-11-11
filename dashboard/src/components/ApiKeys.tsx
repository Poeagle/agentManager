import {useEffect,useState} from 'react';
import {fetchJSON,type MyPermissions,type PermissionGrants,type PermissionLevel} from '../lib/api';
import {Dialog} from './Dialog';
import {DataTable} from './table/DataTable';
import {TableActionButton} from './table/TableActions';
import {useTableModel} from './table/use-table-model';

type KeyRecord={id:string;name:string;created_at:string;expires_at:string;last_used_at:string|null;grants:PermissionGrants};
const rank:Record<PermissionLevel,number>={read:1,write:2,delete:3};
const labels:Record<PermissionLevel,string>={read:'读取',write:'读写',delete:'读写及删除'};
function tomorrow(){const d=new Date(Date.now()+86400000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}

export function ApiKeys({permissions}:{permissions:MyPermissions}){
  const [keys,setKeys]=useState<KeyRecord[]>([]),[name,setName]=useState(''),[expires,setExpires]=useState(tomorrow);
  const [grants,setGrants]=useState<PermissionGrants>({}),[open,setOpen]=useState(false);
  const [secret,setSecret]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const describe=(key:KeyRecord)=>Object.entries(key.grants).map(([id,level])=>`${permissions.catalog.find(item=>item.key===id)?.label||id}：${level?labels[level]:''}`).join('、');
  const table=useTableModel(keys,[{key:'name',title:'名称',value:k=>k.name},{key:'grants',title:'授权范围',value:describe},{key:'expires',title:'到期时间',value:k=>k.expires_at},{key:'last',title:'最近使用',value:k=>k.last_used_at},{key:'status',title:'状态',value:k=>Date.parse(k.expires_at)<=Date.now()?'已过期':'有效'}]);
  const load=async()=>{setLoading(true);try{const result=await fetchJSON<{keys:KeyRecord[]}>('/auth/api-keys');setKeys(result.keys);setError('');}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const close=()=>{setOpen(false);setSecret('');setError('');setName('');setGrants({});setExpires(tomorrow());};
  const create=async(e:React.FormEvent)=>{e.preventDefault();setError('');setBusy(true);try{
    const date=new Date(expires);if(!Number.isFinite(date.getTime()))throw Error('请选择有效到期时间');
    const result=await fetchJSON<{key:string;record:KeyRecord}>('/auth/api-keys',{method:'POST',body:JSON.stringify({name,expires_at:date.toISOString(),grants})});
    setSecret(result.key);setKeys(current=>[result.record,...current]);
  }catch(e){setError(e instanceof Error?e.message:'创建失败');}finally{setBusy(false);}};
  const revoke=async(id:string)=>{setError('');try{await fetchJSON(`/auth/api-keys/${encodeURIComponent(id)}`,{method:'DELETE'});setKeys(current=>current.filter(k=>k.id!==id));}catch(e){setError(e instanceof Error?e.message:'撤销失败');}};
  const input='min-w-0 rounded border px-2 py-1.5 text-sm';
  return <section className="mt-7 flex flex-col gap-3" aria-labelledby="api-keys-title">
    <div className="flex items-center justify-between gap-3"><h3 id="api-keys-title" className="text-sm font-medium">API Key</h3><button type="button" className="rounded px-3 py-1.5 text-sm" style={{background:'var(--accent)',color:'white'}} onClick={()=>{setError('');setOpen(true);}}>新建 API</button></div>
    {error&&!open&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>{error}</p>}
    <DataTable label="API Key 列表" model={table} actions loading={loading} empty={!table.rows.length} emptyMessage={keys.length?"没有匹配的 API Key":"暂无 API Key"}>
      {table.rows.map(key=><tr key={key.id}><td>{key.name}</td><td title={describe(key)}>{describe(key)}</td><td>{new Date(key.expires_at).toLocaleString()}</td><td>{key.last_used_at?new Date(key.last_used_at).toLocaleString():'从未使用'}</td><td>{Date.parse(key.expires_at)<=Date.now()?'已过期':'有效'}</td><td><TableActionButton type="button" onClick={()=>void revoke(key.id)}>撤销</TableActionButton></td></tr>)}
    </DataTable>
    {open&&<Dialog appearance="manager" title={secret?'API Key 已创建':'新建 API'} busy={busy} onClose={close}>
      {secret?<div className="flex flex-col gap-3"><p>请立即保存，关闭后无法再次查看。</p><code className="break-all select-all">{secret}</code><div className="flex justify-end"><button type="button" className="rounded px-3 py-1.5 text-sm" style={{background:'var(--accent)',color:'white'}} onClick={close}>完成</button></div></div>:<form onSubmit={create} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs">名称<input autoFocus className={input} value={name} maxLength={80} required onChange={e=>setName(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-xs">到期时间<input className={input} type="datetime-local" required value={expires} onChange={e=>setExpires(e.target.value)} /></label>
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-1 text-xs">授权范围</legend>{permissions.catalog.filter(item=>permissions.permissions[item.key]).map(item=><label key={item.key} className="flex flex-col gap-1 text-xs">{item.label}<select className={input} value={grants[item.key]||''} onChange={e=>setGrants(current=>{const next={...current};if(e.target.value)next[item.key]=e.target.value as PermissionLevel;else delete next[item.key];return next;})}><option value="">不授权</option>{item.levels.filter(level=>rank[level]<=rank[permissions.permissions[item.key]!]).map(level=><option key={level} value={level}>{labels[level]}</option>)}</select></label>)}</fieldset>
        <p className="text-xs" style={{color:'var(--text-secondary)'}}>实际权限不超过账号当前权限。管理 Engine 需要平台设置和 Agent API 权限。</p>
        {error&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={close}>取消</button><button type="submit" disabled={busy||!name.trim()||!Object.keys(grants).length} className="rounded px-3 py-1.5 text-sm disabled:opacity-50" style={{background:'var(--accent)',color:'white'}}>保存</button></div>
      </form>}
    </Dialog>}
  </section>;
}
