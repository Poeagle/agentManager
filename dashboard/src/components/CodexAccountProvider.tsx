import {useCallback,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {CheckCircle2,Edit3,Loader2,RefreshCw,ShieldCheck,Trash2,UserRound} from 'lucide-react';
import {api,type CodexEnvironment} from '../lib/api';
import {CodexAccountProviderEditor} from './CodexAccountProviderEditor';
import {ProviderDeleteDialog} from './ProviderDeleteDialog';

export function CodexAccountProvider({environment,readOnly=false,onDirtyChange}: {
  environment:CodexEnvironment;readOnly?:boolean;onDirtyChange?:(dirty:boolean)=>void;
}) {
  const client=useQueryClient();
  const [editing,setEditing]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [deleting,setDeleting]=useState(false);
  const query=useQuery({queryKey:['codex-account-details',environment.id],queryFn:()=>api.codexEnvironments.details(environment.id),enabled:!editing,retry:false,staleTime:10000});
  const details=query.data?.details;
  const changed=useCallback((value:boolean)=>{setDirty(value);onDirtyChange?.(value);},[onDirtyChange]);
  function cancelEdit(){if(dirty&&!window.confirm('放弃未保存的账号配置修改吗？'))return;changed(false);setEditing(false);}
  async function remove(){await api.codexEnvironments.remove(environment.id);await client.invalidateQueries({queryKey:['codex-environment-management']});}
  if(editing)return <CodexAccountProviderEditor environment={environment} readOnly={readOnly} onDirtyChange={changed} onCancel={cancelEdit} onSaved={()=>{changed(false);setEditing(false);void query.refetch();}}/>;
  return <section className="agent-management-provider-detail codex-account-editor" aria-label="Codex 账号 Provider">
    <header className="codex-account-heading"><div className="codex-account-heading-icon"><UserRound size={21}/></div><div className="codex-account-heading-copy"><span className="agent-management-eyebrow">CODEX 登录账号</span><h3>{environment.name}</h3><p>查看 {environment.connection?.username} 系统用户的实际 Codex 环境。</p></div><span className={`agent-management-pill ${environment.enabled?'ready':''}`}>{environment.enabled?'已启用':'已停用'}</span></header>
    <div className="codex-account-detail-actions"><span><ShieldCheck size={13}/>管理员默认拥有全部权限</span><div><button type="button" className="agent-management-button" onClick={()=>void query.refetch()} disabled={query.isFetching}><RefreshCw size={13} className={query.isFetching?'animate-spin':''}/>刷新详情</button>{!readOnly&&<button type="button" className="agent-management-button agent-management-button-primary" onClick={()=>setEditing(true)}><Edit3 size={13}/>编辑配置</button>}</div></div>
    {query.isPending?<div className="codex-account-detail-loading" role="status"><Loader2 size={18} className="animate-spin"/>正在读取该系统用户的 Codex 详情…</div>:query.isError?<div className="codex-account-card" role="alert"><strong>配置已保存，当前无法读取账号详情</strong><p className="agent-management-error">{query.error instanceof Error?query.error.message:'读取失败，请检查连接配置'}</p><p className="codex-account-description">可先编辑配置修正连接，再重新预检或刷新详情。</p></div>:details&&<div className="codex-account-detail-sections">
      <section className="codex-account-card"><h4><CheckCircle2 size={15}/>账号与运行状态</h4><dl className="codex-account-detail-grid"><div><dt>登录状态</dt><dd>{details.authentication.status==='authenticated'?'已登录':'未登录'}</dd></div><div><dt>账号身份</dt><dd>{details.authentication.email||'该接入未提供邮箱'}</dd></div><div><dt>登录方式 / 套餐</dt><dd>{[details.authentication.type,details.authentication.plan].filter(Boolean).join(' · ')||'未提供'}</dd></div><div><dt>Codex 引擎</dt><dd>{details.engine.state==='connected'?'已连接':'未连接'}{details.engine.pid?` · PID ${details.engine.pid}`:''}</dd></div><div><dt>执行用户</dt><dd>{environment.connection?.username}</dd></div><div><dt>Codex 版本</dt><dd>{details.version||'未提供'}</dd></div></dl></section>
      <section className="codex-account-card"><h4>Codex 配置</h4><dl className="codex-account-detail-grid"><div className="codex-account-wide"><dt>实际可执行文件</dt><dd><code>{details.executable||environment.connection?.codexCommand}</code></dd></div><div className="codex-account-wide"><dt>实际 CODEX_HOME</dt><dd><code>{details.home||'未提供'}</code></dd></div><div><dt>默认模型</dt><dd>{details.settings.model||'使用 Codex 默认值'}</dd></div><div><dt>模型 Provider</dt><dd>{details.settings.model_provider||'使用 Codex 默认值'}</dd></div><div><dt>默认推理强度</dt><dd>{details.settings.model_reasoning_effort||'使用 Codex 默认值'}</dd></div><div><dt>本机连接</dt><dd>127.0.0.1:{environment.connection?.port} · {environment.connection?.authMethod==='password'?'SSH 密码':'SSH 密钥 / Agent'}</dd></div>{details.config.exists&&<div className="codex-account-wide"><dt>配置来源</dt><dd><code>{details.config.path}</code></dd></div>}</dl>{details.config.notice&&<p className="agent-management-hint">{details.config.notice}</p>}</section>
      <section className="codex-account-card"><h4>可用模型 <span className="agent-management-pill">{details.models.length}</span></h4><div className="codex-account-model-cards">{details.models.map(model=><article key={model.model}><strong>{model.name||model.model}</strong><code>{model.model}</code>{model.description&&<p>{model.description}</p>}{model.defaultEffort&&<small>默认推理强度：{model.defaultEffort}</small>}</article>)}</div></section>
      <p className="codex-account-description">最近读取：{new Date(details.checked_at).toLocaleString()} · 仅显示所选系统用户的账号、模型和相关配置。</p>
    </div>}
    {!readOnly&&<footer className="codex-account-footer"><span className="codex-account-description">删除前会检查所有用户的占用标签页。</span><button type="button" className="agent-management-button agent-management-button-danger" aria-label="删除账号 Provider" onClick={()=>setDeleting(true)}><Trash2 size={14}/>删除 Provider</button></footer>}
    {deleting&&<ProviderDeleteDialog environmentId={environment.id} name={environment.name} message="删除此账号 Provider 的平台配置，目标用户的 Codex 登录和会话历史会保留。" onDelete={remove} onCancel={()=>setDeleting(false)}/>}
  </section>;
}
