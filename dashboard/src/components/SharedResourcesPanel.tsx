import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileKey, FolderKey, Loader2, Save, X } from 'lucide-react';
import { api, type SharedResources } from '../lib/api';
import {AiReply} from './AiReply';
import './SettingsPanel.css';
import './SharedResourcesPanel.css';

export function SharedResourcesPanel({ userId }: { userId: string }) {
  const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['shared-resources-file', userId], queryFn: api.sharedResources.get });
  if (query.isPending) return <div className="flex items-center gap-2 p-6 text-sm"><Loader2 className="h-4 w-4 animate-spin" />正在加载共享资源…</div>;
  if (query.error) return <div role="alert" className="p-6 text-sm">{query.error.message}<button onClick={() => { void query.refetch(); }} className="ml-3 underline">重试</button></div>;
  return <SharedResourcesForm key={`${userId}:${query.data.resources.revision}`} userId={userId} initial={query.data.resources} notice={notice} onSaved={() => setNotice('配置已保存。已有会话重载后加载新的使用提示词。')} />;
}

function SharedResourcesForm({ userId, initial, notice, onSaved }: { userId: string; initial: SharedResources; notice: string; onSaved: () => void }) {
  const client = useQueryClient();
  const [directory, setDirectory] = useState(initial.directory);
  const [scope, setScope] = useState(initial.scope_path);
  const [envFile, setEnvFile] = useState(initial.env_file);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [instructionsMode,setInstructionsMode]=useState<'read'|'edit'>('read');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const [editor, setEditor] = useState<{ path: string; content: string; hash: string | null; exists: boolean; revision: number } | null>(null);
  const save = useMutation({
    mutationFn: () => api.sharedResources.save({ directory, scope_path: scope, env_file: envFile, instructions, enabled, revision: initial.revision }),
    onSuccess: data => { client.setQueryData(['shared-resources-file', userId], data); onSaved(); },
  });
  const preview = useMutation({ mutationFn: () => api.sharedResources.preview(scope) });
  const pathSaved = initial.revision > 0 && envFile === initial.env_file && directory === initial.directory;
  async function openFile() {
    setOpenError(''); setOpening(true);
    try { setEditor(await api.sharedResources.openEnv()); }
    catch (error) { setOpenError(error instanceof Error ? error.message : '无法打开凭据文件'); }
    finally { setOpening(false); }
  }
  return <div className="page-content shared-resources-page">
    <div className="mb-6 flex items-start gap-3"><FolderKey className="mt-0.5 h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} /><div><h3 className="text-base font-semibold">个人共享资源</h3><p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>凭据保存在 .env 文件，使用方法写在提示词中。适用项目的会话只加载说明，按需读取凭据。</p></div></div>
    <form className="shared-resources-form" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <fieldset disabled={save.isPending} className="shared-resources-fields">
        <section className="settings-panel-section space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="settings-panel-field"><span>共享工作目录</span><input required aria-label="共享工作目录" className="settings-panel-control" placeholder="/home/你的目录" value={directory} onChange={event => { setDirectory(event.target.value); if (!envFile || envFile === `${directory}/.env`) setEnvFile(`${event.target.value.replace(/\/$/, '')}/.env`); }} /></label>
            <label className="settings-panel-field"><span>生效项目范围</span><input required aria-label="生效项目范围" className="settings-panel-control" placeholder="/home/你的目录" value={scope} onChange={event => { setScope(event.target.value); preview.reset(); }} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用共享资源</label><button type="button" className="text-sm underline" disabled={!scope || preview.isPending} onClick={() => preview.mutate()}>预览覆盖项目</button></div>
          {preview.error && <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>{preview.error.message}</p>}
          {preview.data && <div className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>{preview.data.projects.length ? preview.data.projects.map(project => <p key={project.id}>{project.name} · {project.path}</p>) : <p>此范围内没有已授权项目。</p>}</div>}
        </section>
        <section className="settings-panel-section rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><FileKey className="h-4 w-4" />凭据文件</div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="settings-panel-field min-w-0 flex-1"><span>.env 文件路径</span><input required aria-label=".env 文件路径" className="settings-panel-control font-mono" placeholder="/home/你的目录/.env" value={envFile} onChange={event => setEnvFile(event.target.value)} /></label><button type="button" className="shrink-0 rounded border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: 'var(--border)' }} disabled={!pathSaved || opening} onClick={() => { void openFile(); }}>{opening ? '正在打开…' : '打开文件'}</button></div>
          <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{pathSaved ? '点击打开文件后，可查看、编辑并保存真实的 .env 内容。文件不存在时可在编辑器中新建。' : '设置或修改文件路径后，请先保存配置，再打开文件。'} 文件内容不会自动放进会话提示词。</p>
          {openError && <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--error)' }}>{openError}</p>}
        </section>
        <section className="settings-panel-section shared-instructions">
          <div className="shared-instructions-heading"><span>共享资源使用提示词</span><div role="group" aria-label="提示词显示方式"><button type="button" aria-pressed={instructionsMode==='read'} onClick={()=>setInstructionsMode('read')}>Markdown 阅读</button><button type="button" aria-pressed={instructionsMode==='edit'} onClick={()=>setInstructionsMode('edit')}>编辑源码</button></div></div>
          {instructionsMode==='edit'?<textarea aria-label="共享资源使用提示词" className="settings-panel-control shared-instructions-editor" maxLength={32000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="说明 .env 中有哪些变量、如何读取、如何访问 Jira / Confluence / GitLab。不要在这里填写 Token 或密码。"/>:<div className="shared-instructions-preview" role="region" aria-label="共享资源使用提示词（Markdown）" tabIndex={0}>{instructions?<AiReply content={instructions}/>:<p>尚未填写提示词，点击“编辑源码”开始编写。</p>}</div>}
        </section>
        <footer className="shared-resources-footer">
        <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>提示词和文件位置作为会话启动说明加载。只写变量名和使用方法，敏感值放在 .env 文件里。</p>
        {save.error && <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>{save.error.message}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <button type="submit" disabled={!directory || !scope || !envFile} className="flex items-center gap-2 rounded px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存配置</button>
        </footer>
      </fieldset>
    </form>
    {editor && <SharedEnvEditor initial={editor} onClose={() => setEditor(null)} onSaved={() => { void client.invalidateQueries({ queryKey: ['shared-resources-file', userId] }); }} />}
  </div>;
}

function SharedEnvEditor({ initial, onClose, onSaved }: { initial: { path: string; content: string; hash: string | null; exists: boolean; revision: number }; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState(initial.content);
  const [savedContent, setSavedContent] = useState(initial.content);
  const [hash, setHash] = useState(initial.hash);
  const [exists, setExists] = useState(initial.exists);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = content !== savedContent;
  function close() { if (busy) return; if (dirty) setDiscard(true); else onClose(); }
  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await api.sharedResources.saveEnv({ content, expected_hash: hash, revision: initial.revision });
      setHash(result.hash); setExists(true); setSavedContent(content); setSaved(true); onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : '文件保存失败'); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6" style={{ background: 'rgba(0,0,0,.58)' }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <section role="dialog" aria-modal="true" aria-labelledby="shared-env-title" className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border shadow-xl" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <header className="flex items-center justify-between gap-3 border-b p-4" style={{ borderColor: 'var(--border)' }}><div className="min-w-0"><h4 id="shared-env-title" className="font-semibold">编辑凭据文件</h4><p className="mt-1 break-all font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{initial.path}</p></div><button aria-label="关闭凭据文件" disabled={busy} className="p-2" onClick={close}><X className="h-5 w-5" /></button></header>
      <p className="px-4 pt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>当前显示敏感文件内容，仅当前登录账号可通过此入口查看。{!exists && '文件尚未创建，保存后创建。'}</p>
      <textarea autoFocus aria-label="凭据文件内容" spellCheck={false} autoComplete="off" className="m-4 min-h-0 flex-1 resize-none rounded border p-3 font-mono text-sm leading-6 outline-none" style={{ borderColor: 'var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', tabSize: 2 }} value={content} readOnly={busy} onChange={event => { setContent(event.target.value); setSaved(false); }} />
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t p-4" style={{ borderColor: 'var(--border)' }}><div className="text-sm">{error && <p role="alert" style={{ color: 'var(--error)' }}>{error}</p>}{saved && <p role="status">文件已保存，下次读取时使用新内容。</p>}{discard && <p>有未保存的修改。<button className="ml-2 underline" onClick={onClose}>放弃更改并关闭</button><button className="ml-3 underline" onClick={() => setDiscard(false)}>继续编辑</button></p>}</div><button disabled={busy} className="flex items-center gap-2 rounded px-4 py-2 text-sm text-white" style={{ background: 'var(--accent)' }} onClick={() => { void save(); }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{exists ? '保存文件' : '创建文件'}</button></footer>
    </section>
  </div>;
}
