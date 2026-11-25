import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, FolderOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchJSON } from '../lib/api';
import { MarkdownTable } from './AiReply';

interface SkillFile { name: string; path: string; children?: SkillFile[] }

function buildTree(files: string[]): SkillFile[] {
  const root: SkillFile[] = [];
  for (const file of files) {
    let nodes = root;
    let path = '';
    const segments = file.split('/');
    for (const [index, name] of segments.entries()) {
      path += (path ? '/' : '') + name;
      let entry = nodes.find(node => node.name === name);
      if (!entry) {
        entry = { name, path, children: index < segments.length - 1 ? [] : undefined };
        nodes.push(entry);
      }
      if (entry.children) nodes = entry.children;
    }
  }
  return root;
}

function FileTree({ nodes, selected, onSelect }: { nodes: SkillFile[]; selected: string; onSelect: (file: string) => void }) {
  return <ul className="space-y-0.5 pl-3">
    {nodes.map(node => <li key={node.path}>
      {node.children ? <details open>
        <summary className="cursor-pointer rounded px-1 py-0.5"><FolderOpen className="mx-1 inline h-3.5 w-3.5" aria-hidden="true" />{node.name}/</summary>
        <FileTree nodes={node.children} selected={selected} onSelect={onSelect} />
      </details> : <button type="button" onClick={() => onSelect(node.path)} aria-current={selected === node.path ? 'page' : undefined}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left [overflow-wrap:anywhere]"
        style={selected === node.path ? { background: 'var(--ops-primary-soft)', color: 'var(--accent)' } : undefined}>
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{node.name}
      </button>}
    </li>)}
  </ul>;
}

function linkedFile(current: string, href: string | undefined) {
  if (!href || /^[\w+.-]+:|^[/#]/.test(href)) return undefined;
  const parts = current.split('/').slice(0, -1);
  for (const part of href.split('#')[0].split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function CollaborationSkillPanel() {
  const [file, setFile] = useState('SKILL.md');
  const [source, setSource] = useState(false);
  const manifest = useQuery({
    queryKey: ['agent-docs', 'files'],
    queryFn: ({ signal }) => fetchJSON<{ root: string; files: string[] }>('/integrations/agent-docs', { signal }),
  });
  const document = useQuery({
    queryKey: ['agent-docs', 'file', file],
    queryFn: ({ signal }) => fetchJSON<{ content: string }>(`/integrations/agent-docs?file=${encodeURIComponent(file)}`, { signal }),
    enabled: manifest.data?.files.includes(file) === true,
  });
  const select = (path: string) => { setFile(path); setSource(false); };
  const markdown = file.endsWith('.md');
  const failure = manifest.isError ? manifest : document.isError ? document : null;

  return <div className="page-content min-w-0">
    {manifest.isPending && <p role="status">正在加载文件目录…</p>}
    {failure && <div role="alert" className="mb-2 flex flex-wrap items-center gap-2">
      <span>加载失败。{failure.error?.message}</span>
      <button type="button" className="underline" onClick={() => { void failure.refetch(); }}>重试</button>
    </div>}
    {manifest.data && <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(10rem,15rem)_minmax(0,1fr)]">
      <nav aria-label="agent-docs 文件目录" className="min-w-0 rounded border p-2" style={{ borderColor: 'var(--border)' }}>
        <details open>
          <summary className="cursor-pointer font-semibold"><FolderOpen className="mx-1 inline h-4 w-4" aria-hidden="true" />{manifest.data.root}/</summary>
          <FileTree nodes={buildTree(manifest.data.files)} selected={file} onSelect={select} />
        </details>
      </nav>
      <section className="min-w-0" aria-label="文件内容">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b pb-2" style={{ borderColor: 'var(--border)' }}>
          <code className="min-w-0 break-all">{manifest.data.root}/{file}</code>
          {markdown && <button type="button" aria-pressed={source} onClick={() => setSource(value => !value)}
            className="rounded border px-2" style={{ borderColor: 'var(--border)' }}>查看源码</button>}
        </div>
        {document.isLoading && <p role="status">正在加载文件…</p>}
        {document.data && (markdown && !source
          ? <article className="markdown-preview min-w-0 max-w-4xl break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto">
            <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
              table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
              a: ({ href, children }) => {
                const target = linkedFile(file, href);
                return target && manifest.data.files.includes(target)
                  ? <button type="button" className="inline text-left underline" style={{ color: 'var(--accent)' }} onClick={() => select(target)}>{children}</button>
                  : <a href={href}>{children}</a>;
              },
            }}>{document.data.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')}</ReactMarkdown>
          </article>
          : <pre className="max-w-full overflow-x-auto rounded p-3 text-xs" style={{ background: 'var(--bg-secondary)' }}><code>{document.data.content}</code></pre>)}
      </section>
    </div>}
  </div>;
}
