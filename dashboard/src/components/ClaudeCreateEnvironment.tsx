import {useEffect,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../lib/api';

export function ClaudeCreateEnvironment({onChange,onReady}:{
  onChange:(id:string|undefined)=>void;
  onReady:(ready:boolean)=>void;
}) {
  const query=useQuery({
    queryKey:['claude-environments'],
    queryFn:()=>api.claudeEnvironments.list(),
    retry:false,
  });
  const [chosen,setChosen]=useState('');
  const selected=chosen||query.data?.environments.find(item=>item.enabled)?.id||'';
  useEffect(()=>{
    onChange(selected||undefined);
    if(query.isPending)return;
    onReady(!!selected&&!query.isError);
  },[selected,query.isError,query.isPending,onChange,onReady]);
  return <div className="project-open-environment">
    <label className="project-open-environment-label" htmlFor="claude-create-provider">Claude Provider</label>
    <div className="project-open-environment-controls">
      <div className="project-open-select-wrap">
        <select
          id="claude-create-provider"
          aria-label="新会话 Claude Provider"
          value={selected}
          disabled={query.isPending}
          onChange={event=>setChosen(event.target.value)}
        >
          {!selected&&<option value="">{query.isPending?'读取 Provider…':'暂无可用 Provider'}</option>}
          {query.data?.environments.map(item=>
            <option key={item.id} value={item.id} disabled={!item.enabled}>
              {item.name}
            </option>)}
        </select>
        <ChevronDown size={15} aria-hidden="true"/>
      </div>
    </div>
    {query.isError&&<p role="alert" className="project-open-error">读取 Claude Provider 失败，请刷新后重试。</p>}
    {query.isSuccess&&!selected&&<p role="alert" className="project-open-error">没有可用的 Claude Provider。</p>}
    <p className="project-open-hint">新会话使用所选 Provider 的模型和凭据；可在对话底部切换。</p>
  </div>;
}
