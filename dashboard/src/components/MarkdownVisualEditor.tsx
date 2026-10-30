import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {followDocumentLink} from '../lib/document-links';
import type { api } from '../lib/api';

interface Props {
  value: string;
  onChange: (value: string) => void;
  filesApi: typeof api.files;
  resolveLocalPath: (source: string) => string | null;
  onOpenFile: (path: string, fragment?:string) => void;
}

export function MarkdownVisualEditor({ value, onChange, filesApi, resolveLocalPath, onOpenFile }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastValueRef = useRef(value);
  const extensions = useMemo(() => [
    StarterKit.configure({ link: { openOnClick: false } }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.extend({
      addNodeView() {
        return ({ node }) => {
          const container = document.createElement('span');
          container.className = 'markdown-visual-image';
          const image = document.createElement('img');
          image.alt = node.attrs.alt || '';
          const label = document.createElement('span');
          label.textContent = image.alt || '加载图片…';
          container.append(image, label);
          image.addEventListener('load', () => label.remove());
          image.addEventListener('error', () => { label.textContent = image.alt || '图片加载失败'; });
          const source = String(node.attrs.src || '');
          const localPath = resolveLocalPath(source);
          const controller = new AbortController();
          let objectUrl: string | null = null;
          if (localPath) {
            void filesApi.preview(localPath, controller.signal).then((blob) => {
              if (controller.signal.aborted) return;
              objectUrl = URL.createObjectURL(blob);
              image.src = objectUrl;
            }).catch(() => { label.textContent = image.alt || '图片加载失败'; });
          } else {
            image.src = source;
          }
          return {
            dom: container,
            destroy() {
              controller.abort();
              if (objectUrl) URL.revokeObjectURL(objectUrl);
            },
          };
        };
      },
    }),
  ], [filesApi, resolveLocalPath]);
  const editor = useEditor({
    extensions,
    content: value,
    contentType: 'markdown',
    editorProps: { attributes: { 'aria-label': 'Markdown 可视编辑区', spellcheck: 'false' } },
    onUpdate({ editor: updated }) {
      const markdown = updated.getMarkdown();
      lastValueRef.current = markdown;
      onChangeRef.current(markdown);
    },
  }, [extensions]);

  useEffect(() => {
    if (!editor || value === lastValueRef.current) return;
    lastValueRef.current = value;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);

  const button = (label: string, title: string, action: () => void) => (
    <button type="button" key={title} title={title} aria-label={title} onMouseDown={(event) => event.preventDefault()} onClick={action}>
      {label}
    </button>
  );

  return <div className="markdown-visual-editor">
    <div className="markdown-visual-toolbar" role="toolbar" aria-label="Markdown 格式">
      {button('B', '加粗', () => editor?.chain().focus().toggleBold().run())}
      {button('I', '斜体', () => editor?.chain().focus().toggleItalic().run())}
      {button('H1', '一级标题', () => editor?.chain().focus().toggleHeading({ level: 1 }).run())}
      {button('H2', '二级标题', () => editor?.chain().focus().toggleHeading({ level: 2 }).run())}
      {button('•', '无序列表', () => editor?.chain().focus().toggleBulletList().run())}
      {button('1.', '有序列表', () => editor?.chain().focus().toggleOrderedList().run())}
      {button('☑', '任务列表', () => editor?.chain().focus().toggleTaskList().run())}
      {button('</>', '代码块', () => editor?.chain().focus().toggleCodeBlock().run())}
      {button('▦', '插入表格', () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      {button('🔗', '插入链接', () => {
        if (!editor) return;
        const current = editor.getAttributes('link').href as string | undefined;
        const href = window.prompt('链接地址', current || '');
        if (href === null) return;
        if (!href.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
        else editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
      })}
    </div>
    <EditorContent editor={editor} className="markdown-preview explorer-markdown" onClickCapture={(event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if(!target)return;
      event.preventDefault();
      event.stopPropagation();
      followDocumentLink(target.getAttribute('href')||'',event.currentTarget,resolveLocalPath,onOpenFile);
    }} />
  </div>;
}
