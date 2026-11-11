import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKey, Loader2, Save, X } from 'lucide-react';
import { api, type SharedResources } from '../lib/api';
import {AiReply} from './AiReply';
import {FolderBrowser} from './FolderBrowser';
import {Dialog} from './Dialog';
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
  const [browsing,setBrowsing]=useState(false);
  const envFile=initial.directory===directory&&initial.env_file?initial.env_file:`${directory.replace(/\/$/,'')}/.env`;
  const [instructions, setInstructions] = useState(initial.instructions);
  const [instructionsMode,setInstructionsMode]=useState<'read'|'edit'>('read');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const [createdNotice,setCreatedNotice]=useState(false);
  const [editor, setEditor] = useState<{ path: string; content: string; hash: string | null; exists: boolean; revision: number } | null>(null);
  const save = useMutation({
    mutationFn: (selectedDirectory:string) => api.sharedResources.save({ directory:selectedDirectory, instructions, enabled, revision: initial.revision }),
    onSuccess: data => { client.setQueryData(['shared-resources-file', userId], data); onSaved(); },
  });
  const pathSaved = initial.revision > 0 && directory === initial.directory;
  const legacy=pathSaved&&(initial.scope_path!==initial.directory||initial.env_file!==`${initial.directory}/.env`);
  async function openFile() {
    setOpenError(''); setOpening(true);
    try { const opened=await api.sharedResources.openEnv();if(opened.exists)setEditor(opened);else{try{setEditor(await api.sharedResources.createEnv());setCreatedNotice(true);}catch(error){const current=await api.sharedResources.openEnv();if(!current.exists)throw error;setEditor(current);}void client.invalidateQueries({queryKey:['shared-resources-file',userId]});} }
    catch (error) { setOpenError(error instanceof Error ? error.message : '无法打开凭据文件'); }
    finally { setOpening(false); }
  }
  return <div className="page-content shared-resources-page">
    <div className="mb-6 flex items-start gap-3"><FolderKey className="mt-0.5 h-5 w-5 shrink-0" style={{ color: 'var(--accent)' }} /><div><h3 className="text-base font-semibold">个人共享资源</h3><p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>凭据保存在 .env 文件，使用方法写在提示词中。适用项目的会话只加载说明，按需读取凭据。</p></div></div>
    <form className="shared-resources-form" onSubmit={event => { event.preventDefault(); save.mutate(directory); }}>
      <fieldset disabled={save.isPending} className="shared-resources-fields">
        <section className="settings-panel-section shared-paths">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>启用共享资源</label>
          <div className="shared-path-row"><span>共享工作目录</span><span className="shared-path-value" title={directory}>{directory||'请先选择共享工作目录'}</span><button type="button" onClick={()=>setBrowsing(true)}>选择目录</button></div>
          <div className="shared-path-row"><span>.env 凭据</span><span className="shared-path-value" title={directory?envFile:''}>{directory?envFile:'请先选择共享工作目录'}</span><span>{pathSaved?(initial.env_exists?'已存在':'尚未创建'):''}</span><button type="button" disabled={!pathSaved||opening} onClick={()=>void openFile()}>{opening?'正在打开…':initial.env_exists?'打开':'创建并打开'}</button></div>
          <p className="shared-path-note">仅对共享目录内且已授权的项目生效；选择目录会保存配置。</p>
          {legacy&&<p role="status" className="shared-path-note">旧配置仍按原范围和文件生效；保存后改为共享目录范围及根目录 .env，原文件不会删除。</p>}
          {openError&&<p role="alert">{openError}</p>}
          {createdNotice&&<p role="status">已创建 .env，可打开编辑</p>}
        </section>
        <section className="settings-panel-section shared-instructions">
          <div className="shared-instructions-heading"><span>共享资源使用提示词</span><div role="group" aria-label="提示词显示方式"><button type="button" aria-pressed={instructionsMode==='read'} onClick={()=>setInstructionsMode('read')}>Markdown 阅读</button><button type="button" aria-pressed={instructionsMode==='edit'} onClick={()=>setInstructionsMode('edit')}>编辑源码</button></div></div>
          {instructionsMode==='edit'?<textarea aria-label="共享资源使用提示词" className="settings-panel-control shared-instructions-editor" maxLength={32000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="说明 .env 中有哪些变量、如何读取、如何访问 Jira / Confluence / GitLab。不要在这里填写 Token 或密码。"/>:<div className="shared-instructions-preview" role="region" aria-label="共享资源使用提示词（Markdown）" tabIndex={0}>{instructions?<AiReply content={instructions}/>:<p>尚未填写提示词，点击“编辑源码”开始编写。</p>}</div>}
        </section>
        <footer className="shared-resources-footer">
        <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>提示词和文件位置作为会话启动说明加载。只写变量名和使用方法，敏感值放在 .env 文件里。</p>
        {save.error && <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>{save.error.message}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        <button type="submit" disabled={!directory} className="flex items-center gap-2 rounded px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存配置</button>
        </footer>
      </fieldset>
    </form>
    {browsing&&<Dialog title="选择共享工作目录" onClose={()=>setBrowsing(false)}><FolderBrowser browse={api.sharedResources.browse} cacheKey="shared-directory-browse" onSelect={path=>{setDirectory(path);setBrowsing(false);save.mutate(path);}}/></Dialog>}
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
