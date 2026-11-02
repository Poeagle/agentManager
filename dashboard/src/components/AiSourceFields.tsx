import {useRef} from 'react';
import {useQuery} from '@tanstack/react-query';
import {fetchJSON} from '../lib/api';
import type {AiSource,AiClientDiscovery} from '../lib/ai-source';
export function AiSourceFields({value,onChange,disabled=false,model,onModelChange}:{value?:AiSource;onChange:(value:AiSource,defaultModel?:string)=>void;disabled?:boolean;model?:string;onModelChange?:(model:string)=>void}) {
 const source=value||{kind:'api'},force=useRef(false);
 const query=useQuery({queryKey:['ai-sources','discovery'],queryFn:({signal})=>{const refresh=force.current;force.current=false;return fetchJSON<{clients:AiClientDiscovery[]}>(`/ai-sources${refresh?'?refresh=true':''}`,{signal});},staleTime:60000,retry:false,refetchOnWindowFocus:false});
 const client=query.data?.clients.find(client=>client.kind===source.kind),local=source.kind==='codex'||source.kind==='claude';
 const clientModels=client?.models||[];
 const custom=!!source.executable?.trim()&&source.executable!==source.kind&&source.executable!==client?.executable;
 const style={background:'var(--bg-primary)',color:'var(--text-primary)',borderColor:'var(--border)'};
 const connectionFields=<>
  <label className="block">{source.kind==='command'?'适配器程序路径':'客户端路径（可选，默认自动查找）'}<input aria-label="AI 程序路径" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.executable||''} placeholder={source.kind==='command'?'/path/to/adapter':client?.executable||source.kind} onChange={event=>onChange({...source,executable:event.target.value})}/></label>
  {source.kind==='command'&&<><label className="block">程序参数（JSON 数组）<textarea aria-label="AI 程序参数" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.arguments_json||'[]'} onChange={event=>onChange({...source,arguments_json:event.target.value})}/></label><label className="block">适配器登录来源<select aria-label="适配器登录来源" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.credential_profile||'none'} onChange={event=>onChange({...source,credential_profile:event.target.value as AiSource['credential_profile']})}><option value="none">不提供账号凭据</option><option value="codex">仅 Codex 当前访问凭据</option><option value="claude">仅 Claude 当前访问凭据</option></select></label></>}
  <label className="block">额外模型域名（可选，JSON 数组）<input aria-label="额外模型域名" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.allowed_hosts_json||'[]'} onChange={event=>onChange({...source,allowed_hosts_json:event.target.value})}/></label>
 </>;
 return <div className="space-y-3 text-sm"><label className="block">AI 来源<select aria-label="AI 来源" disabled={disabled} className="mt-2 w-full rounded border p-2" style={style} value={source.kind} onChange={event=>{const kind=event.target.value as AiSource['kind'];onChange({kind},query.data?.clients.find(client=>client.kind===kind)?.default_model||'');}}>
  <option value="api">外部兼容 API</option><option value="codex">服务器 Codex 客户端</option><option value="claude">服务器 Claude 客户端</option><option value="command">通用命令适配器</option>
 </select></label>
 {local&&<section aria-label="客户端自动探测" className="space-y-2 rounded border p-3 text-xs leading-6" style={{borderColor:'var(--border)',color:'var(--text-secondary)'}}>
  <div className="flex items-center justify-between gap-3"><strong className="font-medium">{query.isFetching?'正在探测客户端…':'客户端自动探测'}</strong><button type="button" disabled={disabled||query.isFetching} className="shrink-0 underline" onClick={()=>{force.current=true;void query.refetch();}}>重新探测</button></div>
  {query.isError?<p role="status">探测暂不可用，可重新探测或手动填写配置。</p>:client&&<>
   <p>{client.installed?`已找到 ${client.kind}${client.version?' '+client.version:''}`:'未找到默认客户端，不会自动安装。'}</p>
   {client.executable&&<p className="break-all">程序路径：{client.executable}</p>}
   <p>{client.login==='detected'?client.credential_source==='environment'?'已检测到服务器 API 凭据':'已检测到本地登录信息':client.login==='expired'?'本地登录信息已过期，请先在客户端重新登录':'未检测到可复用的登录信息，请先在客户端登录'}</p>
   {client.default_model&&<p>本机配置模型：{client.default_model}</p>}
   <p>自动探测只读取程序和本机记录，不调用模型、不刷新登录。模型权限、额度和连通性仍通过下方测试确认。</p>
   {custom&&<p>以上为默认客户端信息；自定义程序路径不会自动执行，请通过测试确认。</p>}
  </>}
 </section>}
 {local&&onModelChange&&client&&<label className="block">选择检测到的模型<select aria-label="客户端模型" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={clientModels.some(item=>item.id===model)?model:''} onChange={event=>onModelChange(event.target.value)}><option value="">使用客户端默认模型</option>{clientModels.map(item=><option key={item.id} value={item.id}>{item.name===item.id?item.id:`${item.name} · ${item.id}`}</option>)}</select><span className="mt-1 block text-xs" style={{color:'var(--text-muted)'}}>{clientModels.length?`来自本机配置或客户端缓存，共 ${clientModels.length} 个候选模型，未逐一验证权限。`:'未发现模型目录，可使用客户端默认模型或手动填写。'}{model&&!clientModels.some(item=>item.id===model)?' 当前填写的模型不在检测目录中，请确认后测试。':''}</span></label>}
 {source.kind!=='api'&&<p className="text-xs leading-6" style={{color:'var(--text-muted)'}}>{source.kind==='command'?'程序从标准输入读取 octoally.ai.v1 JSON，向标准输出返回结构化回复。':'使用服务器客户端已有登录，无需另填 API Key。'}运行时隔离项目文件并关闭本机工具；官方模型域名已内置，其他域名可在高级设置中填写。</p>}
 {local?<details className="space-y-3"><summary className="cursor-pointer text-xs" style={{color:'var(--text-muted)'}}>高级设置：程序路径与额外域名</summary>{connectionFields}</details>:source.kind==='command'?connectionFields:null}
 </div>;
}
