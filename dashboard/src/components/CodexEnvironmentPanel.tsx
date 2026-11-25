import {useState,useEffect} from 'react';
import {copyConversationText} from '../lib/conversation-clipboard';
import type {EnvironmentCheck} from '../lib/api';
const labels:Record<string,string>={configuration:'配置校验',ssh_connection:'SSH 连接',ssh_authentication:'SSH 认证',ssh_host_key:'主机指纹',codex_authentication:'Codex 登录',codex_executable:'Codex 可执行文件',codex_socket:'Codex 引擎',codex_process:'Codex 进程',models:'模型列表',project_access:'项目权限',attachment_access:'历史附件权限',history_access:'历史记录',runtime:'运行环境'};
export function EnvironmentDiagnostic({message}:{message:string}) {
 const [copyState,setCopyState]=useState('');
 useEffect(()=>setCopyState(''),[message]);
 async function copy(){try{await copyConversationText(message);setCopyState('已复制');}catch{setCopyState('复制失败，请手动选择文本复制');}}
 return <><span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{message}</span>{message.includes('\n')&&<span className="mt-2 flex flex-wrap items-center gap-2"><button type="button" className="conversation-action-button conversation-action-button--compact" onClick={()=>void copy()}>复制诊断与命令</button>{copyState&&<span role="status">{copyState}</span>}</span>}</>;
}
export function EnvironmentChecks({checks}:{checks:EnvironmentCheck[]}) {
 return <ul aria-label="环境预检结果" className="space-y-1">{checks.map((check,i)=><li key={i} role={check.ok?'status':'alert'} style={{color:check.ok?'var(--text-secondary)':'var(--error)'}}>{check.ok?'✓':'✗'} {labels[check.stage]||check.stage}：<EnvironmentDiagnostic message={check.message}/></li>)}</ul>;
}
