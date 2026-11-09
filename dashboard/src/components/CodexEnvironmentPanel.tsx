import type {EnvironmentCheck} from '../lib/api';
const labels:Record<string,string>={configuration:'配置校验',ssh_connection:'SSH 连接',ssh_authentication:'SSH 认证',ssh_host_key:'主机指纹',codex_authentication:'Codex 登录',codex_executable:'Codex 可执行文件',codex_socket:'Codex 引擎',codex_process:'Codex 进程',models:'模型列表',project_access:'项目权限',history_access:'历史记录',runtime:'运行环境'};
export function EnvironmentChecks({checks}:{checks:EnvironmentCheck[]}) {
 return <ul aria-label="环境预检结果" className="mt-2 space-y-1 text-sm">{checks.map((check,i)=><li key={i} role={check.ok?'status':'alert'} style={{color:check.ok?'var(--text-secondary)':'var(--danger, #dc2626)'}}>{check.ok?'✓':'✗'} {labels[check.stage]||check.stage}：{check.message}</li>)}</ul>;
}
