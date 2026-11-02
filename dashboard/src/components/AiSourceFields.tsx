import {useQuery} from '@tanstack/react-query';
import {fetchJSON} from '../lib/api';
import type {AiSource} from '../lib/ai-source';
export function AiSourceFields({value,onChange,disabled=false}:{value?:AiSource;onChange:(value:AiSource)=>void;disabled?:boolean}) {
 const source=value||{kind:'api'},query=useQuery({queryKey:['ai-sources'],queryFn:()=>fetchJSON<{clients:Array<{kind:string;installed:boolean}>}>('/ai-sources'),staleTime:60000,retry:false});
 const installed=query.data?.clients.find(client=>client.kind===source.kind)?.installed;
 const style={background:'var(--bg-primary)',color:'var(--text-primary)',borderColor:'var(--border)'};
 return <div className="space-y-3 text-sm"><label className="block">AI 来源<select aria-label="AI 来源" disabled={disabled} className="mt-2 w-full rounded border p-2" style={style} value={source.kind} onChange={event=>onChange({...source,kind:event.target.value as AiSource['kind']})}>
  <option value="api">外部兼容 API</option><option value="codex">服务器 Codex 客户端</option><option value="claude">服务器 Claude 客户端</option><option value="command">通用命令适配器</option>
 </select></label>
 {source.kind!=='api'&&<><p className="text-xs leading-6" style={{color:'var(--text-muted)'}}>{source.kind==='command'?'接入其他 AI：程序从标准输入读取 octoally.ai.v1 JSON，向标准输出返回结构化回复。':'使用服务器客户端已有的登录，无需在这里另填 API Key。'+(installed===true?'已检测到程序；登录、模型及额度通过“测试”验证。':installed===false?'未检测到默认程序，可填写路径；不会自动安装。':'')} 模型名可留空使用客户端默认值。运行时隔离项目文件、关闭本机工具，仅允许连接模型域名；不允许调用服务器其他服务。</p>
 <label className="block">{source.kind==='command'?'适配器程序路径':'客户端路径（可选）'}<input aria-label="AI 程序路径" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.executable||''} placeholder={source.kind==='command'?'/path/to/adapter':source.kind} onChange={event=>onChange({...source,executable:event.target.value})}/></label>
 {source.kind==='command'&&<label className="block">程序参数（JSON 数组）<textarea aria-label="AI 程序参数" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.arguments_json||'[]'} onChange={event=>onChange({...source,arguments_json:event.target.value})}/></label>}</>}
 {source.kind==='command'&&<label className="block">适配器登录来源<select aria-label="适配器登录来源" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.credential_profile||'none'} onChange={event=>onChange({...source,credential_profile:event.target.value as AiSource['credential_profile']})}><option value="none">不提供账号凭据</option><option value="codex">仅 Codex 当前访问凭据</option><option value="claude">仅 Claude 当前访问凭据</option></select></label>}
 {source.kind!=='api'&&<label className="block">额外模型域名（可选，JSON 数组）<input aria-label="额外模型域名" className="mt-2 w-full rounded border p-2" style={style} disabled={disabled} value={source.allowed_hosts_json||'[]'} onChange={event=>onChange({...source,allowed_hosts_json:event.target.value})}/></label>}
 </div>;
}
