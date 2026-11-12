import {useEffect,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api,type AuthUser,type MyPermissions,type ProjectToolPermissions,type UserEngineAccess} from '../lib/api';
import {hasPermission} from '../lib/permissions';

const fieldStyle={background:'var(--bg-primary)',color:'var(--text-primary)',border:'1px solid var(--border)'};
const empty=():ProjectToolPermissions=>({can_session:false,can_terminal:false,session_clients:[]});

/** Each save changes only this user and the selected resource. */
export function UserResourcePermissions({user,permissions}:{user:AuthUser;permissions:MyPermissions}) {
  return <>
    {hasPermission(permissions,'project_access')&&<ProjectPermission user={user} canWrite={hasPermission(permissions,'project_access','write')}/>}
    {hasPermission(permissions,'settings')&&<EnginePermission user={user} canWrite={hasPermission(permissions,'settings','write')&&hasPermission(permissions,'users','write')&&(!user.role_ids?.some(id=>id!=='member')||hasPermission(permissions,'roles','write'))}/>}
  </>;
}
function ProjectPermission({user,canWrite}:{user:AuthUser;canWrite:boolean}) {
  const client=useQueryClient(),[selected,setSelected]=useState(''),[draft,setDraft]=useState<ProjectToolPermissions>(empty),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const projects=useQuery({queryKey:['projects'],queryFn:()=>api.projects.list(),retry:false});
  const projectId=selected||projects.data?.projects[0]?.id||'';
  const project=projects.data?.projects.find(item=>item.id===projectId);
  const access=useQuery({queryKey:['project-access',projectId],queryFn:()=>api.projects.access(projectId),enabled:!!projectId,retry:false});
  useEffect(()=>{
    const data=access.data;if(!data)return;
    const existing=data.access.find(item=>item.user_id===user.id);
    const inherited=user.role==='admin'||(!existing&&project?.owner_id===user.id);
    setDraft(inherited?{can_session:true,can_terminal:true,session_clients:data.clients.map(c=>c.id)}:existing?{can_session:existing.can_session,can_terminal:existing.can_terminal,session_clients:existing.session_clients}:empty());
  },[access.data,projectId,project?.owner_id,user.id,user.role]);
  async function save(){if(!projectId||saving)return;setSaving(true);setError('');setNotice('');try{
    await api.projects.setAccess(projectId,user.id,draft);await access.refetch();await client.invalidateQueries({queryKey:['projects']});setNotice('项目权限已保存');
  }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setSaving(false);}}
  const disabled=!canWrite||saving||access.isPending||access.isError||user.role==='admin'||!!user.disabled;
  return <section className="space-y-2 border-t pt-3" style={{borderColor:'var(--border)'}} aria-label="项目与工具权限">
    <h4 className="text-sm font-semibold">项目与工具权限</h4>
    <label className="flex flex-wrap items-center gap-2 text-xs">项目<select aria-label="选择项目" value={projectId} onChange={e=>{setSelected(e.target.value);setError('');setNotice('');}} disabled={saving||!projects.data?.projects.length} className="min-w-0 rounded px-2 py-1" style={fieldStyle}>{!projectId&&<option value="">暂无项目</option>}{projects.data?.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {projects.isError||access.isError?<p role="alert" className="text-xs">项目权限读取失败，请关闭后重试。</p>:projectId&&<>
      <fieldset disabled={disabled} className="flex flex-wrap items-center gap-3 text-xs"><legend className="sr-only">项目可用工具</legend>
        {access.data?.clients.map(c=><label key={c.id} className="flex items-center gap-1"><input type="checkbox" checked={draft.session_clients.includes(c.id)} onChange={e=>setDraft(old=>{const ids=e.target.checked?[...old.session_clients,c.id]:old.session_clients.filter(id=>id!==c.id);return {...old,session_clients:ids,can_session:ids.length>0};})}/>{c.label}</label>)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={draft.can_terminal} onChange={e=>setDraft(old=>({...old,can_terminal:e.target.checked}))}/>Terminal</label>
        {canWrite&&user.role!=='admin'&&<button type="button" onClick={()=>void save()} disabled={disabled} className="rounded border px-2 py-1" style={fieldStyle}>{saving?'保存中…':'保存项目权限'}</button>}
      </fieldset>
      <p className="text-xs" style={{color:'var(--text-secondary)'}}>{user.role==='admin'?'管理员拥有全部项目访问权限。':'保存更改会关闭该用户的活动会话，权限立即生效。'}</p>
    </>}
    {notice&&<p role="status" className="text-xs">{notice}</p>}{error&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>{error}</p>}
  </section>;
}
function EnginePermission({user,canWrite}:{user:AuthUser;canWrite:boolean}) {
  const client=useQueryClient(),query=useQuery({queryKey:['user-engine-access',user.id],queryFn:()=>api.users.engineAccess(user.id),retry:false});
  const [draft,setDraft]=useState<Record<string,UserEngineAccess['access']>>({}),[saving,setSaving]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{if(query.data)setDraft(Object.fromEntries(query.data.environments.map(e=>[e.id,e.access])));},[query.data]);
  const changed=query.data?.environments.some(e=>draft[e.id]!==e.access);
  async function save(){if(!query.data||saving||!changed)return;setSaving(true);setError('');setNotice('');try{
    await api.users.setEngineAccess(user.id,query.data.environments.filter(e=>draft[e.id]!==e.access).map(e=>({id:e.id,access:draft[e.id]})));
    await Promise.all([query.refetch(),client.invalidateQueries({queryKey:['codex-environments']}),client.invalidateQueries({queryKey:['session-environments']})]);setNotice('Engine 权限已保存');
  }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setSaving(false);}}
  return <section className="space-y-2 border-t pt-3" style={{borderColor:'var(--border)'}} aria-label="Engine 权限">
    <h4 className="text-sm font-semibold">Engine 权限</h4>
    <p className="text-xs" style={{color:'var(--text-secondary)'}}>默认遵循现有 Engine 授权策略；单独允许或禁止只影响此用户。</p>
    {query.isPending?<p className="text-xs">读取中…</p>:query.isError?<p role="alert" className="text-xs">Engine 权限读取失败，请关闭后重试。</p>:<>
      <div className="space-y-1">{query.data?.environments.map(e=><div key={e.id} className="flex flex-wrap items-center gap-2 text-xs"><span className="min-w-32 flex-1">{e.name}{!e.enabled?' · 已停用':''}</span><span style={{color:'var(--text-secondary)'}}>{e.effective?'当前可用':'当前不可用'}</span><select aria-label={`${e.name} Engine 权限`} value={draft[e.id]??e.access} disabled={!canWrite||saving||query.data?.administrator||!!user.disabled} onChange={event=>setDraft(old=>({...old,[e.id]:event.target.value as UserEngineAccess['access']}))} className="rounded px-2 py-1" style={fieldStyle}><option value="inherit">遵循默认策略</option><option value="allow">允许</option><option value="deny">禁止</option></select></div>)}</div>
      {canWrite&&!query.data?.administrator&&<button type="button" disabled={saving||!changed||!!user.disabled} onClick={()=>void save()} className="rounded border px-2 py-1 text-xs disabled:opacity-50" style={fieldStyle}>{saving?'保存中…':'保存 Engine 权限'}</button>}
    </>}
    {notice&&<p role="status" className="text-xs">{notice}</p>}{error&&<p role="alert" className="text-xs" style={{color:'var(--error)'}}>{error}</p>}
  </section>;
}
