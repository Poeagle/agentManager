import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { platformAiApi, type ProjectNotificationInput, type ProjectNotificationRule } from '../lib/platform-ai';
import { DataTable } from './table/DataTable';
import { useTableModel } from './table/use-table-model';
import { TableActionButton, TableActions } from './table/TableActions';

const field = 'rounded-md border px-3 py-2 text-sm disabled:opacity-40';
const style = {background: 'var(--bg-primary)', borderColor: 'var(--border)', color: 'var(--text-primary)'};
const empty: ProjectNotificationInput = {project_id: '', recipient_id: '', enabled: true, on_complete: true, on_input: true};

export function ProjectNotificationsPanel({canWrite, enabled}: {canWrite: boolean; enabled: boolean}) {
  const query = useQuery({queryKey: ['platform-ai-project-notifications'], queryFn: platformAiApi.projectNotifications, refetchInterval: 15000});
  const client = useQueryClient();
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function mutate(work: () => Promise<unknown>, success: string, reset = false) {
    setBusy(true); setError(''); setNotice('');
    try {
      await work();
      if (reset) { setDraft(empty); setEditing(undefined); }
      await client.invalidateQueries({queryKey: ['platform-ai-project-notifications']});
      setNotice(success);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  }
  function edit(rule: ProjectNotificationRule) {
    setEditing(rule.id);
    setDraft({project_id: rule.project_id, recipient_id: rule.recipient_id, enabled: !!rule.enabled, on_complete: !!rule.on_complete, on_input: !!rule.on_input});
    setError(''); setNotice('');
  }
  const data = query.data;
  const projectName = (rule: ProjectNotificationRule) => data?.projects.find(project => project.id === rule.project_id)?.name || rule.project_id;
  const recipientName = (rule: ProjectNotificationRule) => data?.recipients.find(recipient => recipient.id === rule.recipient_id)?.name || '渠道或绑定已失效';
  const eventNames = (rule: ProjectNotificationRule) => [rule.on_complete && '任务完成', rule.on_input && '需要输入'].filter(Boolean).join('、');
  const table = useTableModel(data?.rules ?? [], [
    {key: 'project', title: '项目', value: projectName},
    {key: 'recipient', title: '接收渠道', value: recipientName},
    {key: 'events', title: '通知事件', value: eventNames},
    {key: 'status', title: '状态', value: rule => rule.enabled ? '已启用' : '已暂停'},
  ]);
  return <div className="space-y-5 p-5">
    <div><h3 className="text-sm font-semibold">项目自动通知</h3><p className="mt-2 text-xs leading-6" style={{color: 'var(--text-secondary)'}}>选择项目后，自动关注你在该项目下的所有 Agent 会话，包括后续新建的会话和已绑定 Agent 的终端。任务完成或需要你输入时，通过所选渠道通知，无需逐个登记任务。</p></div>
    {!enabled && <p role="status" className="rounded border p-3 text-sm" style={style}>平台 AI 尚未启用。可以先保存通知规则，管理员启用平台 AI 后开始处理通知。</p>}
    {query.isPending && <p className="text-sm">正在加载项目通知…</p>}
    {query.error && <p role="alert" className="text-sm text-red-400">加载失败：{query.error.message}<button className="ml-3 underline" onClick={() => void query.refetch()}>重试</button></p>}
    {data && <>
      {data.recipients.length === 0 && <p className="rounded border p-3 text-sm leading-6" style={style}>暂无可用接收渠道。请联系管理员在“渠道与用户映射”中绑定你的账号，或添加企业微信群通知订阅，并启用渠道。</p>}
      <DataTable label="项目通知规则" model={table} minWidth={640} actions empty={table.rows.length === 0} emptyMessage="尚未配置项目通知">
        {table.rows.map(rule => <tr key={rule.id}>
          <td>{projectName(rule)}</td><td>{recipientName(rule)}</td><td>{eventNames(rule)}</td>
          <td><span>{rule.enabled ? '已启用' : '已暂停'}</span>{rule.error && <p className="mt-1 max-w-xs whitespace-normal text-xs text-red-400">{rule.error}</p>}</td>
          <td><TableActions>
            <TableActionButton disabled={!canWrite || busy} onClick={() => edit(rule)}>编辑</TableActionButton>
            <TableActionButton disabled={!canWrite || busy} onClick={() => void mutate(() => platformAiApi.saveProjectNotification({project_id: rule.project_id, recipient_id: rule.recipient_id, enabled: !rule.enabled, on_complete: !!rule.on_complete, on_input: !!rule.on_input}, rule.id), rule.enabled ? '已暂停通知' : '已启用通知')}>{rule.enabled ? '暂停' : '启用'}</TableActionButton>
            <TableActionButton disabled={!canWrite || busy} onClick={() => void mutate(() => platformAiApi.deleteProjectNotification(rule.id), '已删除通知规则', editing === rule.id)}>删除</TableActionButton>
          </TableActions></td>
        </tr>)}
      </DataTable>
      <form onSubmit={event => {event.preventDefault(); void mutate(() => platformAiApi.saveProjectNotification(draft, editing), '通知规则已保存', true);}}>
        <fieldset disabled={!canWrite || busy} className="space-y-4 rounded-lg border p-4" style={{borderColor: 'var(--border)'}}>
          <legend className="px-2 text-sm font-medium">{editing ? '编辑通知规则' : '添加通知规则'}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm">项目<select required className={field} style={style} value={draft.project_id} onChange={event => setDraft({...draft, project_id: event.target.value})}><option value="">选择项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label className="flex flex-col gap-2 text-sm">接收渠道<select required className={field} style={style} value={draft.recipient_id} onChange={event => setDraft({...draft, recipient_id: event.target.value})}><option value="">选择接收渠道</option>{data.recipients.map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.on_complete} onChange={event => setDraft({...draft, on_complete: event.target.checked})} />任务完成时通知</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.on_input} onChange={event => setDraft({...draft, on_input: event.target.checked})} />需要输入时通知</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({...draft, enabled: event.target.checked})} />启用此规则</label></div>
          <p className="text-xs leading-6" style={{color: 'var(--text-secondary)'}}>状态事件触发后立即检查；最终答复需经平台 AI 识别，实际送达受模型响应、渠道连接及重试影响。启用前的历史答复不会补发。任务完成表示 Agent 已报告完成，验证情况以原文为准。</p>
          <div className="flex gap-3"><button disabled={!draft.project_id || !draft.recipient_id || (!draft.on_complete && !draft.on_input)} className={field} style={style}>{busy ? '保存中…' : '保存通知规则'}</button>{editing && <button type="button" className={field} style={style} onClick={() => {setDraft(empty); setEditing(undefined);}}>取消编辑</button>}</div>
        </fieldset>
      </form>
    </>}
    {!canWrite && <p className="text-xs" style={{color: 'var(--text-secondary)'}}>当前账号可查看通知规则，需要 Agent API 写权限才能修改。</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="text-sm" style={{color: 'var(--success)'}}>{notice}</p>}
  </div>;
}
