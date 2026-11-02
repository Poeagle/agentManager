import {MarkdownDiagramPre} from './MermaidDiagram';
import { memo,type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownTable({children,className='my-3 max-w-full overflow-x-auto rounded-md'}:{children:ReactNode;className?:string}) {
  return <div role="region" aria-label="横向滚动表格" tabIndex={0} className={className}><table style={{width:'max-content',minWidth:'100%',margin:0}}>{children}</table></div>;
}

const components: Components = {
  pre:MarkdownDiagramPre,
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  a: ({ href, children, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
};

// Unchanged replies should not be parsed again for each streamed text update.
export const AiReply = memo(function AiReply({content}: {content: string}) {
  return <div className="markdown-preview min-w-0 max-w-full break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_pre]:max-w-full [&_pre_code]:whitespace-pre [&_th]:whitespace-nowrap">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{content}</ReactMarkdown>
  </div>;
});
