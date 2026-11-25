import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchJSON } from '../lib/api';
import { MarkdownTable } from './AiReply';

const documents = [
  { id: 'skill', label: '正文', file: 'SKILL.md' },
  { id: 'tabs', label: '标签页', file: 'tabs.md' },
  { id: 'messages', label: '消息投递', file: 'messages.md' },
  { id: 'allocation', label: '配置分配', file: 'allocation.md' },
] as const;

export function CollaborationSkillPanel() {
  const [document, setDocument] = useState<(typeof documents)[number]['id']>('skill');
  const query = useQuery({
    queryKey: ['collaboration-skill', document],
    queryFn: ({ signal }) => fetchJSON<{ markdown: string }>(`/integrations/collaboration-skill/${document}`, { signal }),
  });

  return <div className="page-content min-w-0">
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code className="break-all text-sm">agent-manager-collaboration</code>
      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>文档可查看，标签页协作待接入</span>
    </div>
    <nav aria-label="协作 Skill 文档" className="mb-3 flex flex-wrap gap-1 border-b pb-2" style={{ borderColor: 'var(--border)' }}>
      {documents.map(item => <button type="button" key={item.id} onClick={() => setDocument(item.id)}
        aria-current={document === item.id ? 'page' : undefined} className="rounded px-2 py-1 text-sm"
        style={{ color: document === item.id ? 'var(--accent)' : 'var(--text-secondary)', background: document === item.id ? 'var(--ops-primary-soft)' : 'transparent' }}>
        {item.label}
      </button>)}
    </nav>
    {query.isPending && <p role="status" className="text-sm">正在加载文档…</p>}
    {query.isError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      <span>文档加载失败。{query.error.message}</span>
      <button type="button" className="underline" onClick={() => { void query.refetch(); }}>重试</button>
    </div>}
    {query.data && <article className="markdown-preview min-w-0 max-w-4xl break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
        table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
        a: ({ href, children }) => {
          const target = documents.find(item => item.file === href?.split('#')[0]?.split('/').at(-1));
          return target
            ? <button type="button" className="inline text-left underline" style={{ color: 'var(--accent)' }} onClick={() => setDocument(target.id)}>{children}</button>
            : <a href={href}>{children}</a>;
        },
      }}>{query.data.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')}</ReactMarkdown>
    </article>}
  </div>;
}
