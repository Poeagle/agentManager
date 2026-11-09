import {useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../lib/api';
import {ConfirmModal} from './ConfirmModal';
import {DataTable} from './table/DataTable';
import {useTableModel,type TableColumn} from './table/use-table-model';
import type {ProviderUsageTab} from '../lib/api';
const columns:TableColumn<ProviderUsageTab>[]=[{key:'username',title:'平台用户',value:t=>t.username},{key:'project',title:'项目',value:t=>t.project_name},{key:'name',title:'标签页',value:t=>t.name},{key:'model',title:'模型',value:t=>t.model},{key:'status',title:'运行状态',value:t=>t.busy===true?'正在执行任务':t.busy===false?'空闲':t.status==='pending'?'等待启动':'状态未确认'}];
export function ProviderUsageTable({environmentId,onStateChange}:{environmentId:string;onStateChange?:(state:{inUse:boolean;busy:boolean;verified:boolean})=>void}) {
 const client=useQueryClient();const query=useQuery({queryKey:['provider-usage',environmentId],queryFn:async()=>{const data=await api.codexEnvironments.usage(environmentId);onStateChange?.({inUse:!!data.tabs.length,busy:data.busy,verified:data.verified});return data;},retry:false,refetchInterval:10000});
 const [selected,setSelected]=useState<string[]>([]),[confirm,setConfirm]=useState<string[]|null>(null),[working,setWorking]=useState(false),[error,setError]=useState('');
 const tabs=query.data?.tabs||[],ids=tabs.map(tab=>tab.id),picked=selected.filter(id=>ids.includes(id));
 const table=useTableModel(tabs,columns);
 async function close(){if(!confirm||working)return;setWorking(true);setError('');try{const result=await api.codexEnvironments.closeTabs(environmentId,confirm);const failed=result.results.filter(r=>!r.ok);setSelected(failed.map(r=>r.id));if(failed.length)setError(failed.map(r=>`${r.id}：${r.error}`).join('；'));setConfirm(null);await Promise.all([query.refetch(),client.invalidateQueries({queryKey:['sessions']}),client.invalidateQueries({queryKey:['project-sessions']})]);}catch(e){setError(e instanceof Error?e.message:'删除失败，标签页已保留');}finally{setWorking(false);}}
 return <section className="agent-management-section" aria-label="Provider 占用标签页">
  <div className="agent-management-section-title"><div><h4>占用此 Provider 的标签页</h4><p>检查所有平台用户。任务执行中不能调整或重启；删除 Provider 前须先关闭全部占用标签页。</p></div><div className="agent-management-status-row"><button type="button" className="agent-management-button" disabled={working||query.isFetching} onClick={()=>void query.refetch()}>刷新占用情况</button><button type="button" className="agent-management-button agent-management-button-danger" disabled={working||!picked.length} onClick={()=>setConfirm(picked)}>批量删除标签页（{picked.length}）</button></div></div>
  {!!tabs.length&&<label><input type="checkbox" aria-label="全选占用标签页" checked={picked.length===ids.length} disabled={working} onChange={e=>setSelected(e.target.checked?ids:[])}/> 全选占用标签页</label>}
  <DataTable label="Provider 占用标签页列表" model={table} actions loading={query.isPending} error={query.isError?'无法读取占用情况，请刷新后再操作。':undefined} empty={!tabs.length} emptyMessage="当前没有用户占用此 Provider。" onRetry={()=>void query.refetch()}>
   {table.rows.map(tab=><tr key={tab.id}><td>{tab.username}</td><td>{tab.project_name}</td><td title={tab.id}><label><input type="checkbox" aria-label={`选择标签页 ${tab.name}`} checked={picked.includes(tab.id)} disabled={working} onChange={e=>setSelected(old=>e.target.checked?[...old,tab.id]:old.filter(id=>id!==tab.id))}/> {tab.name}</label></td><td>{tab.model||'未提供'}</td><td>{tab.busy===true?'正在执行任务':tab.busy===false?'空闲':tab.status==='pending'?'等待启动':'状态未确认'}</td><td><button type="button" className="agent-management-button agent-management-button-danger" disabled={working} onClick={()=>setConfirm([tab.id])}>删除标签页</button></td></tr>)}
  </DataTable>
  {error&&<p role="alert" className="agent-management-error">{error}</p>}
  {confirm&&<ConfirmModal title="删除占用标签页" message={`将停止并移除所选 ${confirm.length} 个标签页，包括其他用户的标签页。正在执行的任务会被停止，会话历史保留。`} confirmLabel={working?'正在删除…':'确认删除标签页'} cancelLabel="取消" variant="danger" onCancel={()=>{if(!working)setConfirm(null);}} onConfirm={()=>void close()}/>}
 </section>;
}
