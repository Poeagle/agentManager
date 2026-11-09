import {useEffect,useId,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {KeyRound,Loader2,PlugZap,Save,Server,ShieldCheck,TerminalSquare,Trash2,UserRound} from 'lucide-react';
import {api,type CodexEnvironment,type EnvironmentCheck} from '../lib/api';
import {useProviderUsage} from '../lib/use-provider-usage';
import {EnvironmentChecks} from './CodexEnvironmentPanel';
import {ProviderDeleteDialog} from './ProviderDeleteDialog';

export function CodexAccountProviderEditor({environment,onSaved,onDirtyChange,onCancel,readOnly=false}: {
  environment?:CodexEnvironment;
  onSaved:(environment:CodexEnvironment)=>void;
  onDirtyChange?:(dirty:boolean)=>void;
  readOnly?:boolean;
  onCancel?:()=>void;
}) {
  const client=useQueryClient();
  const query=useQuery({queryKey:['codex-environment-management'],queryFn:()=>api.codexEnvironments.management(),retry:false});
  const projects=useQuery({queryKey:['projects'],queryFn:()=>api.projects.list(),retry:false});
  const usage=useProviderUsage(environment?.id);
  const original=environment?.connection;
  const [name,setName]=useState(environment?.name||'');
  const [username,setUsername]=useState(original?.username||'');
  const [port,setPort]=useState(original?.port||22);
  const [auth,setAuth]=useState<'password'|'key'>(original?.authMethod||'password');
  const [password,setPassword]=useState('');
  const [key,setKey]=useState(original?.identityFile||'');
  const [command,setCommand]=useState(original?.codexCommand||'codex');
  const [home,setHome]=useState(original?.codexHome||'');
  const [users,setUsers]=useState<string[]>(environment?.allowed_user_ids||[]);
  const [enabled,setEnabled]=useState(environment?.enabled??true);
  const [projectId,setProjectId]=useState('');
  const [working,setWorking]=useState<'check'|'save'|null>(null);
  const [error,setError]=useState('');
  const [checks,setChecks]=useState<EnvironmentCheck[]>([]);
  const [models,setModels]=useState<string[]>([]);
  const [removeConfirm,setRemoveConfirm]=useState(false);
  const commandHint=useId();
  const commandError=command.trim()&&/\s/.test(command.trim())?'这里只填写 codex 或可执行文件的绝对路径，不要附加启动参数。':'';
  const connection={username,port,authMethod:auth,identityFile:auth==='key'?key:'',codexCommand:command,codexHome:home,...auth==='password'&&password?{password}:{}};
  const hasPassword=!!password||!!original?.passwordConfigured&&username===original.username&&port===original.port;
  const ready=!!username&&!!command.trim()&&!commandError&&(auth==='key'||hasPassword);
  const members=query.data?.users.filter(user=>user.role!=='admin')||[];

  useEffect(()=>{
    onDirtyChange?.(name!==(environment?.name||'')||username!==(original?.username||'')||port!==(original?.port||22)||auth!==(original?.authMethod||'password')||!!password||key!==(original?.identityFile||'')||command!==(original?.codexCommand||'codex')||home!==(original?.codexHome||'')||JSON.stringify(users)!==JSON.stringify(environment?.allowed_user_ids||[])||enabled!==(environment?.enabled??true));
  },[name,username,port,auth,password,key,command,home,users,enabled,environment,original,onDirtyChange]);

  async function check() {
    if(!ready||working)return;
    setWorking('check');setError('');setChecks([]);setModels([]);
    try {
      const result=await api.codexEnvironments.checkConnection({...connection,...environment?{environment_id:environment.id}:{},...projectId?{project_id:projectId}:{}});
      setChecks(result.checks);setModels(result.models?.map(model=>model.model)||[]);
    } catch(failure) {setError(failure instanceof Error?failure.message:'预检失败');}
    finally {setWorking(null);}
  }
  async function save() {
    if(!ready||working)return;
    setWorking('save');setError('');
    try {
      const result=await api.codexEnvironments.save({name,enabled,allowed_user_ids:users,connection},environment?.id);
      setPassword('');onDirtyChange?.(false);
      await Promise.all(['codex-environment-management','session-environments','codex-environments'].map(key=>client.invalidateQueries({queryKey:[key]})));
      onSaved(result.environment);
    } catch(failure) {setError(failure instanceof Error?failure.message:'保存失败');}
    finally {setWorking(null);}
  }
  async function remove() {
    await api.codexEnvironments.remove(environment!.id);
    onDirtyChange?.(false);
    await Promise.all(['codex-environment-management','session-environments','codex-environments'].map(key=>client.invalidateQueries({queryKey:[key]})));
  }

  return <section className="agent-management-provider-detail codex-account-editor" aria-label="Codex 账号 Provider">
    <header className="codex-account-heading">
      <div className="codex-account-heading-icon"><UserRound size={21}/></div>
      <div className="codex-account-heading-copy"><span className="agent-management-eyebrow">CODEX 登录账号</span><h3>{environment?.name||'新增账号 Provider'}</h3><p>使用本机系统用户已经登录的 Codex，执行身份与账号保持一致。</p></div>
      <span className={`agent-management-pill ${enabled?'ready':''}`}>{enabled?'已启用':'已停用'}</span>
    </header>
    <div className="codex-account-summary"><span><Server size={13}/>127.0.0.1 · 本机</span><span><UserRound size={13}/>{username||'待设置系统用户'}</span><span><ShieldCheck size={13}/>管理员默认拥有全部权限</span></div>

    <form onSubmit={event=>{event.preventDefault();void save();}} onChange={()=>{setChecks([]);setModels([]);}}>
      <fieldset className="codex-account-card" disabled={readOnly||!!working}>
        <legend><Server size={15}/>连接设置</legend><p className="codex-account-description">通过本机 SSH 以指定系统用户运行，不需要填写远程服务器地址。</p>
        <div className="codex-account-grid">
          <label className="agent-management-field"><span>Provider 名称</span><input aria-label="账号 Provider 名称" placeholder="例如：ymchen 的 Codex" required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label>
          <label className="agent-management-field"><span>系统用户名</span><input aria-label="系统用户名" placeholder="例如：ymchen" required value={username} onChange={event=>setUsername(event.target.value)}/></label>
          <label className="agent-management-field"><span>SSH 端口</span><input aria-label="本机 SSH 端口" type="number" min={1} max={65535} required value={port} onChange={event=>setPort(Number(event.target.value))}/></label>
          <label className="agent-management-field"><span>SSH 认证方式</span><select aria-label="SSH 认证方式" value={auth} onChange={event=>{setAuth(event.target.value as 'password'|'key');setPassword('');}}><option value="password">系统用户密码</option><option value="key">SSH 密钥 / Agent</option></select></label>
          <div className="codex-account-wide">{auth==='password'?<label className="agent-management-field"><span><KeyRound size={13}/>SSH 登录密码{original?.passwordConfigured&&<small>已加密保存</small>}</span><input aria-label="SSH 登录密码" type="password" autoComplete="new-password" value={password} placeholder={original?.passwordConfigured?'留空保留已保存密码':'填写该系统用户的 SSH 密码'} onChange={event=>setPassword(event.target.value)}/><small>密码仅用于 SSH 认证，加密保存，不回显。</small></label>:<label className="agent-management-field"><span><KeyRound size={13}/>SSH 私钥文件</span><input aria-label="SSH 私钥文件" value={key} placeholder="例如：/home/xlli/.ssh/id_ed25519" onChange={event=>setKey(event.target.value)}/><small>留空使用平台进程的默认密钥或 SSH Agent。</small></label>}</div>
        </div>
      </fieldset>

      <fieldset className="codex-account-card" disabled={readOnly||!!working}>
        <legend><TerminalSquare size={15}/>Codex 环境</legend><p className="codex-account-description">沿用目标系统用户的登录状态。未登录时，预检会提示该用户先运行 codex login。</p>
        <div className="codex-account-grid">
          <label className="agent-management-field"><span>Codex 可执行文件</span><input aria-label="Codex 命令" aria-describedby={commandHint} aria-invalid={!!commandError} required value={command} placeholder="codex 或 /home/用户名/.local/bin/codex" onChange={event=>setCommand(event.target.value)}/><small id={commandHint}>{commandError||'只填写命令名或绝对路径，不要附加启动参数。会话权限由平台控制。'}</small>{commandError&&<span role="alert" className="agent-management-error">例如填写 codex，无需添加 --dangerously-bypass-approvals-and-sandbox。</span>}</label>
          <label className="agent-management-field"><span>CODEX_HOME <small>可选</small></span><input aria-label="CODEX_HOME" value={home} placeholder="默认：目标用户的 ~/.codex" onChange={event=>setHome(event.target.value)}/><small>仅在该用户使用自定义 Codex 目录时填写。</small></label>
        </div>
      </fieldset>

      <fieldset className="codex-account-card" disabled={readOnly||!!working}>
        <legend><ShieldCheck size={15}/>使用权限</legend><p className="codex-account-description">选择可使用此账号的普通平台用户。管理员自动拥有全部权限，无需勾选。</p>
        <div className="codex-account-users">{query.isPending?<p>正在读取平台用户…</p>:query.isError?<p role="alert" className="agent-management-error">无法读取用户列表，请刷新页面后重试。</p>:members.length?members.map(user=><label key={user.id} className={`codex-account-user${users.includes(user.id)?' selected':''}`}><input type="checkbox" aria-label={`允许 ${user.username} 使用`} checked={users.includes(user.id)} onChange={event=>setUsers(old=>event.target.checked?[...old,user.id]:old.filter(id=>id!==user.id))}/><span className="codex-account-avatar">{(user.display_name||user.username).slice(0,1).toUpperCase()}</span><span><strong>{user.display_name||user.username}</strong><small>{user.username}</small></span></label>):<p className="codex-account-description">暂无普通用户，此 Provider 仅管理员可用。</p>}</div>
      </fieldset>

      <section className="codex-account-card codex-account-preflight" aria-label="账号连接预检">
        <div className="codex-account-card-heading"><div><h4><PlugZap size={15}/>连接预检</h4><p className="codex-account-description">检查 SSH、已有登录、模型列表，以及测试项目的读写权限。</p></div><button type="button" className="agent-management-button" aria-label="预检连接、已有登录、模型与项目" disabled={!!working||!ready} onClick={()=>void check()}>{working==='check'?<Loader2 size={14} className="animate-spin"/>:<PlugZap size={14}/>} {working==='check'?'正在预检…':'预检连接'}</button></div>
        <label className="agent-management-field"><span>测试项目 <small>可选</small></span><select aria-label="账号预检测试项目" disabled={!!working} value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">仅验证连接、已有登录和模型</option>{projects.data?.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        {checks.length>0&&<EnvironmentChecks checks={checks}/>}
        {models.length>0&&<div className="codex-account-models" aria-label="已检测可用模型"><small>检测到 {models.length} 个可用模型</small><div>{models.map(model=><span key={model}>{model}</span>)}</div></div>}
      </section>
      {error&&<p role="alert" className="agent-management-error">{error}</p>}
      {environment&&(usage.busy||!usage.verified)&&<p className="agent-management-hint">{usage.isPending?'正在检查 Provider 运行状态…':usage.busy&&usage.verified?'有任务正在执行，完成后可保存设置。':'暂时无法确认运行状态，请检查连接后再保存。'}</p>}
      <footer className="codex-account-footer"><label className="codex-account-enabled"><input type="checkbox" checked={enabled} disabled={readOnly||!!working} onChange={event=>{setEnabled(event.target.checked);setChecks([]);setModels([]);}}/>启用此 Provider</label><div>{onCancel&&<button type="button" className="agent-management-button" disabled={!!working} onClick={onCancel}>取消编辑</button>}{environment&&<button type="button" className="agent-management-button agent-management-button-danger" aria-label="删除账号 Provider" disabled={readOnly||!!working} onClick={()=>setRemoveConfirm(true)}><Trash2 size={14}/>删除 Provider</button>}<button type="submit" className="agent-management-button agent-management-button-primary" aria-label="保存账号 Provider" disabled={readOnly||!!working||!name||!ready||!!environment&&(usage.busy||!usage.verified)}>{working==='save'?<Loader2 size={14} className="animate-spin"/>:<Save size={14}/>} {working==='save'?'正在保存…':'保存 Provider'}</button></div></footer>
    </form>
    {removeConfirm&&environment&&<ProviderDeleteDialog environmentId={environment.id} name={environment.name} message="删除此账号 Provider 的平台配置，目标系统用户的 Codex 登录和会话历史会保留。" onCancel={()=>setRemoveConfirm(false)} onDelete={remove}/>}
  </section>;
}
