import {MarkdownDiagramPre} from './MermaidDiagram';
import { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import {followDocumentLink,scrollDocumentFragment} from '../lib/document-links';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, File, ChevronRight, ChevronDown, ChevronUp, Loader2, Save, Circle, Eye, EyeOff, Pencil, Home, X, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, GitCompareArrows, Scissors, Copy as CopyIcon, Clipboard, Trash2, Edit3, Download, RefreshCw, Upload } from 'lucide-react';
import { api, scopeProjectFiles, type FileEntry, type FilePreviewType } from '../lib/api';
import { isExportTransferActive, startExportTransfer, useExportTransferStore } from '../lib/export-transfer';
import { ConfirmModal } from './ConfirmModal';
import { ErrorBoundary } from './ErrorBoundary';
import { SplitHalf, OverviewRuler } from './DiffComponents';
import {
  type HunkInfo,
  parseHunks,
  parseSplitRows,
  MONO,
  HUNK_HIGHLIGHT,
} from '../lib/diff-model';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { DocumentPreview } from './DocumentPreview';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { setEditorDirty } from '../lib/unsaved-files';
import { droppedFiles, isFileDrag, MAX_FILE_UPLOAD_BYTES, safeUploadPath, type FileUploadRequest } from '../lib/file-upload';
import { compareFileEntries, type FileSort } from '../lib/file-sort';
import { isWithinExplorerRoot, normalizeExplorerPath } from '../lib/explorer-path';

const MarkdownVisualEditor = lazy(() => import('./MarkdownVisualEditor').then((module) => ({ default: module.MarkdownVisualEditor })));

export interface FileRefreshRequest {
  path: string;
  revision: number;
}

interface FileExplorerProps {
  rootPath: string;
  projectId?: string;
  instanceId?: string; // unique ID for localStorage persistence
  active?: boolean;
  refreshFileRequest?: FileRefreshRequest | null; // reload matching clean tabs whenever revision changes
  openFileRequest?: { path: string; key: number } | null; // when key changes, open & reveal this file
  onFileSaved?: (filePath: string) => void; // notify parent when a file is saved
  readOnly?: boolean; // when true, disable all writes (save/rename/delete/paste) — view-only
  uploadRequest?: FileUploadRequest | null;
  workspace?: {
    treeHost: HTMLElement | null;
    tabsHost: HTMLElement | null;
    editorActive: boolean;
    onActivate: () => void;
    onEmpty: () => void;
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function restoreExpandedNodes(
  nodes: TreeNode[],
  expandedPaths: Set<string>,
  showHidden: boolean,
  filesApi: typeof api.files,
): Promise<TreeNode[]> {
  return Promise.all(nodes.map(async (node) => {
    if (node.entry.type !== 'directory' || !expandedPaths.has(node.fullPath)) return node;

    try {
      const data = await filesApi.list(node.fullPath, showHidden);
      const children: TreeNode[] = data.files.map((file) => ({
        entry: file,
        fullPath: `${node.fullPath}/${file.name}`,
        children: undefined,
        loaded: false,
        expanded: false,
      }));
      return {
        ...node,
        children: await restoreExpandedNodes(children, expandedPaths, showHidden, filesApi),
        loaded: true,
        expanded: true,
      };
    } catch {
      return node;
    }
  }));
}

interface TreeNode {
  entry: FileEntry;
  fullPath: string;
  children?: TreeNode[];
  loaded: boolean;
  expanded: boolean;
}

function findNodeInTree(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.fullPath === path) return node;
    if (node.children) {
      const found = findNodeInTree(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function updateNodeInTree(nodes: TreeNode[], path: string, updates: Partial<TreeNode>): TreeNode[] {
  return nodes.map((node) => {
    if (node.fullPath === path) return { ...node, ...updates };
    if (node.children) return { ...node, children: updateNodeInTree(node.children, path, updates) };
    return node;
  });
}

interface FileTab {
  path: string;
  name: string;
  pinned: boolean;
  content: string;        // original from disk
  editedContent: string;  // current in editor
  extension: string;
  size: number;
  viewMode: 'edit' | 'preview';
  previewType?: FilePreviewType;
  previewRevision?: number;
}

interface CompareState {
  leftPath: string;
  rightPath: string;
  diff: string;
  hunks: HunkInfo[];
  leftContent: string;   // in-memory content (may have applied hunks)
  rightContent: string;   // in-memory content (may have applied hunks)
  appliedHunks: Map<number, 'left' | 'right'>; // hunkIndex → direction applied
}

interface PersistedExplorerState {
  expandedPaths: string[];
  selectedFile: string | null;
  currentPath?: string;
  openTabPaths?: { path: string; pinned: boolean }[];
  activeTabPath?: string | null;
  showHidden?: boolean;
  sortOrder?: FileSort;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

function isMarkdownFile(ext: string) {
  return MARKDOWN_EXTENSIONS.has(ext);
}

function markdownLocalPath(source: string | undefined, documentPath: string, rootPath: string): string | null {
  if (!source || source.startsWith('//') || source.startsWith('#') || source.startsWith('?')
    || /^[a-z][a-z\d+.-]*:/i.test(source)) return null;
  try {
    const decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]);
    const directory = documentPath.slice(0, documentPath.lastIndexOf('/')) || '/';
    if(decoded.includes('\0'))return null;
    const path = normalizeExplorerPath(decoded.startsWith('/')?decoded:`${directory}/${decoded}`);
    return path && isWithinExplorerRoot(path, rootPath) ? path : null;
  } catch {
    return null;
  }
}

function MarkdownImage({ src, alt, documentPath, rootPath, filesApi }: {
  src?: string;
  alt?: string;
  documentPath: string;
  rootPath: string;
  filesApi: typeof api.files;
}) {
  const localPath = markdownLocalPath(src, documentPath, rootPath);
  const [preview, setPreview] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!localPath) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void filesApi.preview(localPath, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ path: localPath, url: objectUrl });
    }).catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [localPath, filesApi]);
  return <img src={localPath ? (preview?.path === localPath ? preview.url : undefined) : src} alt={alt ?? ''} />;
}

/**
 * Split leading YAML frontmatter (--- ... ---) from a markdown document.
 * react-markdown would otherwise render the fences as <hr> and collapse the
 * key/value lines into one run-on paragraph — so we pull it out and show it
 * as a proper metadata panel, leaving the real body for the renderer.
 */
function splitFrontmatter(text: string): { meta: { key: string; value: string }[]; body: string } {
  const m = text.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return { meta: [], body: text };
  const meta: { key: string; value: string }[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s?(.*)$/);
    if (kv) meta.push({ key: kv[1], value: kv[2] });
    else if (meta.length && line.trim()) meta[meta.length - 1].value += ` ${line.trim()}`; // folded value
  }
  return { meta, body: text.slice(m[0].length) };
}

function FrontmatterPanel({ meta }: { meta: { key: string; value: string }[] }) {
  return (
    <div className="rounded-lg border overflow-hidden mb-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider border-b" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>
        Frontmatter
      </div>
      <div>
        {meta.map((m, i) => (
          <div key={`${m.key}-${i}`} className="flex gap-3 px-3 py-1.5" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
            <span className="text-xs font-mono font-semibold shrink-0" style={{ color: 'var(--accent)', width: 120 }}>{m.key}</span>
            <span className="text-xs break-words min-w-0 leading-relaxed" style={{ color: 'var(--text-primary)' }}>{m.value || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getLanguageExtension(ext: string) {
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return javascript({ jsx: true });
    case 'ts': case 'tsx': case 'mts': case 'cts':
      return javascript({ jsx: true, typescript: true });
    case 'py': case 'pyw':
      return python();
    case 'json': case 'jsonc':
      return json();
    case 'html': case 'htm': case 'svg':
      return html();
    case 'css': case 'scss': case 'less':
      return css();
    case 'md': case 'mdx': case 'markdown':
      return markdownLang();
    case 'rs':
      return rust();
    case 'java':
      return java();
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': case 'cxx':
      return cpp();
    default:
      return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function explorerStorageKey(instanceId: string) {
  return `agentmanager-explorer-${instanceId}`;
}

function loadExplorerState(instanceId: string, rootPath: string): PersistedExplorerState | null {
  try {
    const raw = localStorage.getItem(explorerStorageKey(instanceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.expandedPaths)) {
      const within = (path: unknown): path is string => typeof path === 'string' && isWithinExplorerRoot(path, rootPath);
      return {
        ...parsed,
        currentPath: within(parsed.currentPath) ? normalizeExplorerPath(parsed.currentPath)! : rootPath,
        expandedPaths: parsed.expandedPaths.filter(within),
        selectedFile: within(parsed.selectedFile) ? parsed.selectedFile : null,
        activeTabPath: within(parsed.activeTabPath) ? parsed.activeTabPath : null,
        openTabPaths: Array.isArray(parsed.openTabPaths) ? parsed.openTabPaths.filter((tab: { path?: string } | null) => within(tab?.path)) : [],
      };
    }
  } catch {
    // Ignore malformed or unavailable persisted explorer state.
  }
  return null;
}

function saveExplorerState(instanceId: string, state: PersistedExplorerState) {
  try {
    localStorage.setItem(explorerStorageKey(instanceId), JSON.stringify(state));
  } catch {
    // Explorer persistence is best effort.
  }
}

// Collect all expanded paths from the tree
function getExpandedPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.expanded) {
      paths.push(node.fullPath);
      if (node.children) {
        paths.push(...getExpandedPaths(node.children));
      }
    }
  }
  return paths;
}

interface ContextMenuItem {
  kind?: 'item' | 'separator';
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

function ContextMenu({ x, y, items, onClose }: ContextMenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    // Adjust position if menu would overflow viewport
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      let nx = x;
      let ny = y;
      if (x + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
      if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
      setPos(previous=>previous.x===nx && previous.y===ny?previous:{x:nx,y:ny});
    }
    const onDown = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x,y,onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] rounded-md shadow-lg py-1 text-xs"
      style={{
        left: pos.x,
        top: pos.y,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        minWidth: 200,
        color: 'var(--text-primary)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={i} className="my-1" style={{ borderTop: '1px solid var(--border)' }} />;
        }
        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { if (!item.disabled && item.onClick) { item.onClick(); onClose(); } }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ color: item.danger ? 'var(--error)' : 'var(--text-primary)' }}
          >
            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  onToggle,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  selectedPath,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  cutPath,
}: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDoubleClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  selectedPath: string | null;
  renamingPath: string | null;
  onRenameSubmit: (path: string, newName: string) => void;
  onRenameCancel: () => void;
  cutPath: string | null;
}) {
  const isDir = node.entry.type === 'directory';
  const isSelected = node.fullPath === selectedPath;
  const isRenaming = renamingPath === node.fullPath;
  const isCut = cutPath === node.fullPath;
  const [loading, setLoading] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      // Focus input and select the basename (excluding extension) for files
      setTimeout(() => {
        const el = renameInputRef.current;
        if (!el) return;
        el.focus();
        const name = node.entry.name;
        const dotIdx = !isDir && name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
        el.setSelectionRange(0, dotIdx);
      }, 0);
    }
  }, [isRenaming, node.entry.name, isDir]);

  function handleClick() {
    if (isRenaming) return;
    if (isDir) {
      setLoading(true);
      onToggle(node.fullPath);
      setTimeout(() => setLoading(false), 500);
    } else {
      onFileClick(node.fullPath);
    }
  }

  function handleDoubleClick() {
    if (isRenaming) return;
    if (!isDir) {
      onFileDoubleClick(node.fullPath);
    }
  }

  function commitRename() {
    const trimmed = renameInputRef.current?.value.trim() ?? '';
    if (!trimmed || trimmed === node.entry.name) {
      onRenameCancel();
      return;
    }
    onRenameSubmit(node.fullPath, trimmed);
  }

  return (
    <>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
        data-filepath={node.fullPath}
        data-filetype={node.entry.type}
        title={`${node.fullPath}${node.entry.modified_at ? '\n修改时间：'+new Date(node.entry.modified_at).toLocaleString('zh-CN') : ''}${isDir ? '' : '\n大小：'+formatSize(node.entry.size)}`}
        className="flex items-center gap-1 w-full text-left text-xs py-0.5 px-2 hover:bg-[var(--bg-tertiary)] transition-colors"
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
          background: isSelected ? 'var(--bg-tertiary)' : undefined,
          opacity: isCut ? 0.5 : 1,
        }}
      >
        {isDir ? (
          loading && !node.loaded ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" style={{ color: 'var(--text-secondary)' }} />
          ) : node.expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {isDir ? (
          node.expanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
          )
        ) : (
          <File className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
        )}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            defaultValue={node.entry.name}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.currentTarget.value = node.entry.name;
                onRenameCancel();
              }
            }}
            onBlur={commitRename}
            className="flex-1 min-w-0 text-xs px-1 py-0 rounded"
            style={{
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--accent)',
              outline: 'none',
              fontFamily: 'inherit',
            }}
            spellCheck={false}
          />
        ) : (
          <span className="truncate">{node.entry.name}</span>
        )}
      </button>

      {isDir && node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.fullPath}
          node={child}
          depth={depth + 1}
          onToggle={onToggle}
          onFileClick={onFileClick}
          onFileDoubleClick={onFileDoubleClick}
          onContextMenu={onContextMenu}
          selectedPath={selectedPath}
          renamingPath={renamingPath}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          cutPath={cutPath}
        />
      ))}
    </>
  );
}

export function FileExplorer({ rootPath, projectId, instanceId, active = true, refreshFileRequest, openFileRequest, onFileSaved, readOnly = false, uploadRequest, workspace }: FileExplorerProps) {
  const filesApi = useMemo(() => scopeProjectFiles(api.files, projectId), [projectId]);
  // Resolve initial path from persisted state or prop
  const [initialState] = useState(() => instanceId ? loadExplorerState(instanceId, rootPath) : null);
  const [currentPath, setCurrentPath] = useState(initialState?.currentPath ?? rootPath);
  const [pathInput, setPathInput] = useState(initialState?.currentPath ?? rootPath);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const treeRef=useRef(tree); treeRef.current=tree;
  const [rootLoaded, setRootLoaded] = useState(false);
  const [showHidden, setShowHidden] = useState(initialState?.showHidden ?? true);
  const [sortOrder,setSortOrder]=useState<FileSort>(()=>['name','modified_desc','modified_asc'].includes(initialState?.sortOrder || '') ? initialState!.sortOrder! : 'name');
  const [refreshing,setRefreshing]=useState(false);
  const refreshBusy=useRef(false);
  const fileInputRef=useRef<HTMLInputElement>(null);
  const folderInputRef=useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const uploadBusy = useRef(false);
  const lastUploadRequest = useRef<FileUploadRequest | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; index: number; total: number; percent: number; directory: string } | null>(null);
  const [uploadResult, setUploadResult] = useState<{ error: boolean; text: string } | null>(null);
  const restoringRef = useRef(false);
  const treeScrollRef = useRef<HTMLDivElement>(null);

  // Tab state
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const tabsRef=useRef(tabs); tabsRef.current=tabs;
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [documentAnchor,setDocumentAnchor]=useState<{path:string;fragment:string}|null>(null);

  // Resizable tree panel
  const [treePanelWidth, setTreePanelWidth] = useState(280);
  const isDraggingRef = useRef(false);
  const treePanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.min(Math.max(e.clientX - (treePanelRef.current?.getBoundingClientRect().left ?? 0), 120), 600);
      setTreePanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);

  const startDragging = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Compare mode
  const [compareState, setCompareState] = useState<CompareState | null>(null);
  const [compareSelecting, setCompareSelecting] = useState<string | null>(null); // first selected path
  const [compareHunk, setCompareHunk] = useState(0);

  function handleCompareHunkNav(delta: number) {
    if (!compareState) return;
    const total = compareState.hunks.length;
    if (total === 0) return;
    setCompareHunk(prev => ((prev + delta) % total + total) % total);
  }

  // Shared loading/error state
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Context menu / file ops state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ path: string; isDir: boolean } | null>(null);
  const [clipboard, setClipboard] = useState<{ kind: 'cut' | 'copy'; path: string; isDir: boolean } | null>(null);
  const [actionMessage, setActionMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const exportInProgress = useExportTransferStore((state) => isExportTransferActive(state.task));

  useEffect(()=>{
    if(!active || (workspace && !workspace.treeHost)) {
      setContextMenu(null);setPendingDelete(null);
    }
  },[active,workspace?.treeHost]);

  useEffect(() => {
    if (!actionMessage) return;
    const t = setTimeout(() => setActionMessage(null), 3500);
    return () => clearTimeout(t);
  }, [actionMessage]);

  // Derived state
  const activeTab = tabs.find(t => t.path === activeTabPath) ?? null;
  const isDirty = activeTab ? activeTab.editedContent !== activeTab.content : false;
  const isMarkdown = activeTab ? isMarkdownFile(activeTab.extension) : false;
  const resolveMarkdownLocalPath = useCallback((source: string) =>
    markdownLocalPath(source, activeTabPath ?? rootPath, rootPath), [activeTabPath, rootPath]);

  // Helper to update a specific tab
  const updateTab = useCallback((path: string, updates: Partial<FileTab>) => {
    setTabs(prev => prev.map(t => t.path === path ? { ...t, ...updates } : t));
  }, []);

  // Reveal a file in the tree: expand ancestor folders and scroll to it
  async function revealFileInTree(filePath: string) {
    if (!isWithinExplorerRoot(filePath, currentPath)) return;

    const relative = filePath.slice(currentPath.length + 1);
    const parts = relative.split('/');
    parts.pop(); // remove file name — we only need directories

    // Expand each ancestor directory
    let dirPath = currentPath;
    for (const part of parts) {
      dirPath = `${dirPath}/${part}`;
      const capturedDir = dirPath;

      try {
        const data = await filesApi.list(capturedDir, showHidden);
        setTree(prev => {
          // Use functional updater to see latest state
          const node = findNodeInTree(prev, capturedDir);
          if (!node) return prev;
          if (node.loaded && node.expanded) return prev; // already good
          return updateNodeInTree(prev, capturedDir, {
            children: data.files.map(f => ({
              entry: f,
              fullPath: `${capturedDir}/${f.name}`,
              children: undefined,
              loaded: false,
              expanded: false,
            })),
            loaded: true,
            expanded: true,
          });
        });
      } catch {
        return; // can't expand — stop here
      }
    }

    // After React renders the expanded tree, scroll to the file
    setTimeout(() => {
      const el = treeScrollRef.current?.querySelector(`[data-filepath="${CSS.escape(filePath)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  // Reveal active file in tree when switching tabs
  const revealingRef = useRef(false);
  useEffect(() => {
    if (!activeTabPath || restoringRef.current || revealingRef.current) return;
    revealingRef.current = true;
    revealFileInTree(activeTabPath).finally(() => { revealingRef.current = false; });
    // revealFileInTree intentionally follows the selected path; its other
    // values only affect how that one reveal is performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabPath]);

  // Open a file as a preview (single-click) or pinned (double-click)
  const openFileRequestSequence = useRef(0);
  async function openFile(path: string, pin: boolean, fragment?:string) {
    if (!isWithinExplorerRoot(path, rootPath)) {
      setActionMessage({ kind: 'error', text: '只能访问当前项目目录及其子目录' });
      return;
    }
    workspace?.onActivate();
    setDocumentAnchor(fragment?{path,fragment}:null);
    const requestSequence = ++openFileRequestSequence.current;
    // If already open, just switch to it (and pin if double-click)
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      if (pin || fragment) updateTab(path, { ...(pin?{pinned:true}:{}),...(fragment && isMarkdownFile(existing.extension)?{viewMode:'preview' as const}:{}) });
      setActiveTabPath(path);
      setFileLoading(false);
      setFileError(null);
      return;
    }

    setFileLoading(true);
    setFileError(null);
    try {
      const data = await filesApi.read(path);
      if (requestSequence !== openFileRequestSequence.current) return;
      const newTab: FileTab = {
        path: data.path,
        name: path.split('/').pop() || path,
        pinned: pin,
        content: data.content,
        editedContent: data.content,
        extension: data.extension,
        size: data.size,
        previewType: data.previewType,
        viewMode: isMarkdownFile(data.extension) ? 'preview' : 'edit',
      };

      setTabs(prev => {
        if (!pin) {
          // Replace existing preview tab (if not dirty)
          const previewIdx = prev.findIndex(t => !t.pinned);
          if (previewIdx >= 0) {
            const preview = prev[previewIdx];
            if (preview.editedContent !== preview.content) {
              // Preview is dirty — auto-pin it and add new preview at end
              return [...prev.map((t, i) => i === previewIdx ? { ...t, pinned: true } : t), newTab];
            }
            // Replace the preview tab
            const next = [...prev];
            next[previewIdx] = newTab;
            return next;
          }
        }
        return [...prev, newTab];
      });
      setActiveTabPath(data.path);
    } catch (error) {
      if (requestSequence !== openFileRequestSequence.current) return;
      setFileError(getErrorMessage(error, 'Failed to read file'));
    } finally {
      if (requestSequence === openFileRequestSequence.current) setFileLoading(false);
    }
  }

  // A linked document gets its own tab so the source stays one click away.
  function followDocumentFile(path:string,fragment?:string) {
    if(activeTabPath)updateTab(activeTabPath,{pinned:true});
    void openFile(path,true,fragment);
  }

  useEffect(()=>{
    if(!documentAnchor || documentAnchor.path!==activeTabPath || !containerRef.current)return;
    const root=containerRef.current;
    const observer=new MutationObserver(()=>attempt());
    const attempt=()=>{
      if(scrollDocumentFragment(root,documentAnchor.fragment)) {observer.disconnect();setDocumentAnchor(current=>current===documentAnchor?null:current);}
    };
    observer.observe(root,{subtree:true,childList:true,characterData:true});
    const frame=requestAnimationFrame(attempt);
    const timeout=setTimeout(()=>{observer.disconnect();setDocumentAnchor(current=>current===documentAnchor?null:current);},5000);
    return()=>{observer.disconnect();cancelAnimationFrame(frame);clearTimeout(timeout);};
  },[documentAnchor,activeTabPath]);

  function handleFileClick(path: string) {
    openFile(path, false);
  }

  function handleFileDoubleClick(path: string) {
    openFile(path, true);
  }

  function closeTab(path: string) {
    const idx = tabs.findIndex(t => t.path === path);
    const closing = tabs[idx];
    if (closing && closing.editedContent !== closing.content
      && !window.confirm(`Discard unsaved changes to ${closing.name}?`)) return;
    setTabs(prev => prev.filter(t => t.path !== path));
    if (activeTabPath === path) {
      const remaining = tabs.filter(t => t.path !== path);
      if (remaining.length > 0) {
        // Switch to neighbor tab
        const newIdx = Math.min(idx, remaining.length - 1);
        setActiveTabPath(remaining[newIdx].path);
      } else {
        setActiveTabPath(null);
        if(workspace?.editorActive) workspace.onEmpty();
      }
    }
  }

  // Start compare flow: user clicks compare button, then clicks two tabs
  function startCompare() {
    if (compareState) {
      // Exit compare mode
      setCompareState(null);
      setCompareSelecting(null);
      return;
    }
    // If already selecting, cancel
    if (compareSelecting) {
      setCompareSelecting(null);
      return;
    }
    // Start selecting first file
    setCompareSelecting('waiting');
  }

  async function selectForCompare(path: string) {
    if (!compareSelecting) return;
    if ((tabs.find(tab => tab.path === path)?.previewType ?? 'text') !== 'text') {
      setActionMessage({ kind: 'error', text: '仅支持比较文本文件' });
      return;
    }

    if (compareSelecting === 'waiting') {
      // First pick
      setCompareSelecting(path);
      return;
    }

    // Second pick — start the diff
    const leftPath = compareSelecting;
    const rightPath = path;
    if (leftPath === rightPath) {
      setCompareSelecting(null);
      return;
    }

    setCompareSelecting(null);
    setFileLoading(true);
    try {
      const { diff } = await filesApi.diff(leftPath, rightPath);
      const hunks = parseHunks(diff);
      const leftTab = tabs.find(t => t.path === leftPath);
      const rightTab = tabs.find(t => t.path === rightPath);
      const leftContent = leftTab?.editedContent ?? (await filesApi.read(leftPath)).content;
      const rightContent = rightTab?.editedContent ?? (await filesApi.read(rightPath)).content;

      setCompareState({
        leftPath,
        rightPath,
        diff,
        hunks,
        leftContent,
        rightContent,
        appliedHunks: new Map(),
      });
      setCompareHunk(0);
    } catch (error) {
      setFileError(getErrorMessage(error, 'Failed to compare files'));
    } finally {
      setFileLoading(false);
    }
  }

  // Apply a hunk from one side to the other
  function applyHunk(hunkIndex: number, direction: 'left' | 'right') {
    if (!compareState) return;
    const hunk = compareState.hunks[hunkIndex];
    if (!hunk) return;

    // direction 'right' = copy left content to right file (replace new lines with old lines)
    // direction 'left' = copy right content to left file (replace old lines with new lines)
    const newApplied = new Map(compareState.appliedHunks);
    if (newApplied.get(hunkIndex) === direction) {
      // Toggle off — undo this apply
      newApplied.delete(hunkIndex);
    } else {
      newApplied.set(hunkIndex, direction);
    }
    setCompareState({ ...compareState, appliedHunks: newApplied });
  }

  // Build the effective content for a side after applying hunks
  // Build the effective content for a side after applying hunk choices.
  // Semantics: 'left' arrow = keep left (right file adopts left content for this hunk)
  //            'right' arrow = accept right (left file adopts right content for this hunk)
  function buildEffectiveContent(side: 'left' | 'right'): string {
    if (!compareState) return '';
    const isLeft = side === 'left';
    const lines = (isLeft ? compareState.leftContent : compareState.rightContent).split('\n');

    // Collect hunks that affect this side
    const applicableHunks: { hunk: HunkInfo; dir: 'left' | 'right' }[] = [];
    for (const [idx, dir] of compareState.appliedHunks) {
      const hunk = compareState.hunks[idx];
      if (!hunk) continue;
      // 'right' arrow = accept right → left file changes (adopts right/new content)
      // 'left' arrow = keep left → right file changes (adopts left/old content)
      if ((dir === 'right' && isLeft) || (dir === 'left' && !isLeft)) {
        applicableHunks.push({ hunk, dir });
      }
    }

    // Sort descending by the start line of the side being modified (apply from bottom up)
    applicableHunks.sort((a, b) => {
      const aStart = isLeft ? a.hunk.oldStart : a.hunk.newStart;
      const bStart = isLeft ? b.hunk.oldStart : b.hunk.newStart;
      return bStart - aStart;
    });

    for (const { hunk, dir } of applicableHunks) {
      if (dir === 'right' && isLeft) {
        // "Accept right" → replace left (old) content with right (new) content
        lines.splice(hunk.oldStart - 1, hunk.oldCount, ...hunk.newContent);
      } else if (dir === 'left' && !isLeft) {
        // "Keep left" → replace right (new) content with left (old) content
        lines.splice(hunk.newStart - 1, hunk.newCount, ...hunk.oldContent);
      }
    }

    return lines.join('\n');
  }

  // Save compare changes to disk
  async function saveCompareChanges() {
    if (readOnly) return;
    if (!compareState || compareState.appliedHunks.size === 0) return;
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveMessage(null);

    try {
      // 'right' arrow = accept right → left file changes
      const leftChanged = [...compareState.appliedHunks.values()].some(d => d === 'right');
      // 'left' arrow = keep left → right file changes
      const rightChanged = [...compareState.appliedHunks.values()].some(d => d === 'left');

      if (leftChanged) {
        const newContent = buildEffectiveContent('left');
        await filesApi.write(compareState.leftPath, newContent, compareState.leftContent);
        const leftTab = tabs.find(t => t.path === compareState.leftPath);
        if (leftTab) updateTab(compareState.leftPath, { content: newContent, editedContent: newContent });
        onFileSaved?.(compareState.leftPath);
      }

      if (rightChanged) {
        const newContent = buildEffectiveContent('right');
        await filesApi.write(compareState.rightPath, newContent, compareState.rightContent);
        const rightTab = tabs.find(t => t.path === compareState.rightPath);
        if (rightTab) updateTab(compareState.rightPath, { content: newContent, editedContent: newContent });
        onFileSaved?.(compareState.rightPath);
      }

      setSaveMessage('Saved');
      setTimeout(() => setSaveMessage(null), 2000);

      // Re-fetch diff after save
      const { diff } = await filesApi.diff(compareState.leftPath, compareState.rightPath);
      const hunks = parseHunks(diff);
      const leftContent = (await filesApi.read(compareState.leftPath)).content;
      const rightContent = (await filesApi.read(compareState.rightPath)).content;
      setCompareState({
        leftPath: compareState.leftPath,
        rightPath: compareState.rightPath,
        diff,
        hunks,
        leftContent,
        rightContent,
        appliedHunks: new Map(),
      });
      setCompareHunk(0);
    } catch {
      setSaveMessage('Save failed');
      setTimeout(() => setSaveMessage(null), 3000);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  // Save active tab
  const handleSave = useCallback(async () => {
    if (readOnly || !activeTab || !isDirty) return;
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await filesApi.write(activeTab.path, activeTab.editedContent, activeTab.content);
      updateTab(activeTab.path, { content: activeTab.editedContent, size: result.size });
      setSaveMessage('Saved');
      onFileSaved?.(activeTab.path);
      setTimeout(() => setSaveMessage(null), 2000);
    } catch {
      setSaveMessage('Save failed');
      setTimeout(() => setSaveMessage(null), 3000);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [activeTab, isDirty, onFileSaved, readOnly, updateTab, filesApi]);

  // Ctrl+S / Cmd+S keyboard shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (active && (!workspace || workspace.editorActive) && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, handleSave, workspace?.editorActive]);

  // External "open this file" request — e.g. user clicked an icon in the git panel
  const lastOpenRequestKey = useRef<number | null>(null);
  useEffect(() => {
    if (!openFileRequest || !rootLoaded) return;
    if (openFileRequest.key === lastOpenRequestKey.current) return;
    lastOpenRequestKey.current = openFileRequest.key;
    void openFile(openFileRequest.path, true);
    // openFile sets activeTabPath, which the existing reveal effect picks up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFileRequest, rootLoaded]);

  // Refresh open tab when another view (e.g. git diff) saved it
  const lastRefreshRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!refreshFileRequest || refreshFileRequest.revision === lastRefreshRevision.current) return;
    lastRefreshRevision.current = refreshFileRequest.revision;
    const refreshFilePath = refreshFileRequest.path;

    // Find any open tab matching this path that isn't dirty
    const tab = tabs.find(t => t.path === refreshFilePath);
    if (tab && tab.editedContent === tab.content) {
      const expectedContent = tab.content;
      const expectedRevision = refreshFileRequest.revision;
      filesApi.read(refreshFilePath).then((data) => {
        if (lastRefreshRevision.current !== expectedRevision) return;
        setTabs((currentTabs) => currentTabs.map((currentTab) => {
          if (currentTab.path !== refreshFilePath
            || currentTab.content !== expectedContent
            || currentTab.editedContent !== currentTab.content) return currentTab;
          return {
            ...currentTab,
            content: data.content,
            editedContent: data.content,
            size: data.size,
          };
        }));
      }).catch(() => {});
    }
  }, [refreshFileRequest, tabs, filesApi]);

  const hasUnsavedTabs = useMemo(
    () => tabs.some((tab) => tab.editedContent !== tab.content),
    [tabs],
  );
  useEffect(() => {
    if (!instanceId) return;
    setEditorDirty(instanceId, rootPath, hasUnsavedTabs);
    return () => setEditorDirty(instanceId, rootPath, false);
  }, [hasUnsavedTabs, instanceId, rootPath]);

  // Persist explorer state on changes
  useEffect(() => {
    if (!instanceId || !rootLoaded || restoringRef.current) return;
    const expandedPaths = getExpandedPaths(tree);
    saveExplorerState(instanceId, {
      expandedPaths,
      selectedFile: activeTabPath,
      currentPath,
      openTabPaths: tabs.map(t => ({ path: t.path, pinned: t.pinned })),
      activeTabPath,
      showHidden,
      sortOrder,
    });
  }, [instanceId, tree, activeTabPath, rootLoaded, currentPath, tabs, showHidden,sortOrder]);

  // Load the root from an effect. A generation guard prevents a slow response
  // for an old path from replacing the tree after the user navigates elsewhere.
  const rootLoadSequence = useRef(0);
  const tabsRestoredRef = useRef(false);
  useEffect(() => {
    const requestSequence = ++rootLoadSequence.current;
    let cancelled = false;

    const load = async () => {
      try {
        const data = await filesApi.list(currentPath, showHidden);
        const savedState = instanceId ? loadExplorerState(instanceId, rootPath) : null;
        const expandedPaths = new Set(savedState?.expandedPaths ?? []);
        const rootNodes: TreeNode[] = data.files.map((file) => ({
          entry: file,
          fullPath: `${currentPath}/${file.name}`,
          children: undefined,
          loaded: false,
          expanded: false,
        }));
        const restoredTree = await restoreExpandedNodes(rootNodes, expandedPaths, showHidden, filesApi);

        let restoredTabs: FileTab[] = [];
        if (!tabsRestoredRef.current && savedState?.openTabPaths?.length) {
          const loadedTabs = await Promise.all(savedState.openTabPaths.map(async ({ path, pinned }) => {
            try {
              const fileData = await filesApi.read(path);
              return {
                path: fileData.path,
                name: path.split('/').pop() || path,
                pinned,
                content: fileData.content,
                editedContent: fileData.content,
                extension: fileData.extension,
                size: fileData.size,
                previewType: fileData.previewType,
                viewMode: isMarkdownFile(fileData.extension) ? 'preview' as const : 'edit' as const,
              };
            } catch {
              return null;
            }
          }));
          restoredTabs = loadedTabs.filter((tab) => tab !== null);
        } else if (!tabsRestoredRef.current && savedState?.selectedFile) {
          try {
            const fileData = await filesApi.read(savedState.selectedFile);
            restoredTabs = [{
              path: fileData.path,
              name: savedState.selectedFile.split('/').pop() || savedState.selectedFile,
              pinned: true,
              content: fileData.content,
              editedContent: fileData.content,
              extension: fileData.extension,
              size: fileData.size,
              previewType: fileData.previewType,
              viewMode: isMarkdownFile(fileData.extension) ? 'preview' : 'edit',
            }];
          } catch {
            // The legacy file may have been deleted.
          }
        }

        if (cancelled || requestSequence !== rootLoadSequence.current) return;
        restoringRef.current = true;
        setTree(restoredTree);
        if (restoredTabs.length > 0) {
          setTabs(restoredTabs);
          const savedActivePath = savedState?.activeTabPath;
          setActiveTabPath(
            savedActivePath && restoredTabs.some((tab) => tab.path === savedActivePath)
              ? savedActivePath
              : restoredTabs[0].path,
          );
        }
        tabsRestoredRef.current = true;
        setRootLoaded(true);
        restoringRef.current = false;
      } catch (error) {
        if (cancelled || requestSequence !== rootLoadSequence.current) return;
        restoringRef.current = false;
        setFileError(getErrorMessage(error, 'Failed to load directory'));
        setRootLoaded(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [currentPath, instanceId, showHidden, filesApi, rootPath]);

  function navigateTo(path: string) {
    const trimmed = normalizeExplorerPath(path.trim());
    if (!trimmed || !isWithinExplorerRoot(trimmed, rootPath)) {
      setPathInput(currentPath);
      setActionMessage({ kind: 'error', text: '只能访问当前项目目录及其子目录' });
      return;
    }
    if (trimmed === currentPath) return;
    setCurrentPath(trimmed);
    setPathInput(trimmed);
    // Reset tree state so loadRoot fires again
    setTree([]);
    setRootLoaded(false);
    setFileError(null);
  }

  function navigateUp() {
    if (normalizeExplorerPath(currentPath) === normalizeExplorerPath(rootPath)) return;
    const parent = currentPath.replace(/\/[^/]+$/, '') || '/';
    navigateTo(parent);
  }

  function handlePathSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigateTo(pathInput);
  }

  async function toggleDir(path: string) {
    setTree((prev) => toggleInTree(prev, path));
  }

  function toggleInTree(nodes: TreeNode[], path: string): TreeNode[] {
    return nodes.map((node) => {
      if (node.fullPath === path) {
        if (node.expanded) {
          return { ...node, expanded: false };
        }
        if (!node.loaded) {
          filesApi.list(path, showHidden).then((data) => {
            setTree((prev) =>
              updateNodeInTree(prev, path, {
                children: data.files.map((f) => ({
                  entry: f,
                  fullPath: `${path}/${f.name}`,
                  children: undefined,
                  loaded: false,
                  expanded: false,
                })),
                loaded: true,
                expanded: true,
              })
            );
          });
          return { ...node, expanded: true };
        }
        return { ...node, expanded: true };
      }
      if (node.children) {
        return { ...node, children: toggleInTree(node.children, path) };
      }
      return node;
    });
  }

  function getParentDir(p: string): string {
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx);
  }

  // Reload one directory in the tree (or the whole root when dir === currentPath).
  // Preserves expanded state of unaffected subtrees by only replacing the children of the target.
  const refreshDirectory = useCallback(async (dir: string) => {
    const sequence = rootLoadSequence.current;
    try {
      const data = await filesApi.list(dir, showHidden);
      const freshNodes:TreeNode[]=data.files.map(entry=>({entry,fullPath:`${dir}/${entry.name}`,loaded:false,expanded:false}));
      const freshChildren=await restoreExpandedNodes(freshNodes,new Set(getExpandedPaths(treeRef.current)),showHidden,filesApi);
      if (sequence !== rootLoadSequence.current) return;
      setTree(prev => {
        const node = findNodeInTree(prev, dir);
        const isRoot = dir === currentPath;
        if (!isRoot && !node) return prev;
        // Merged folder uploads can change an already expanded subtree.
        if (isRoot) return freshChildren;
        return updateNodeInTree(prev, dir, {
          children: freshChildren,
          loaded: true,
          expanded: true,
        });
      });
    } catch (error) {
      setActionMessage({ kind: 'error', text: getErrorMessage(error, 'Failed to refresh directory') });
    }
  }, [currentPath, showHidden, filesApi]);

  async function refreshExplorer() {
    if(refreshBusy.current) return;
    refreshBusy.current=true; setRefreshing(true); setFileError(null);
    const sequence=rootLoadSequence.current;
    const scrollTop=treeScrollRef.current?.scrollTop ?? 0;
    const snapshot=activeTab;
    try {
      const data=await filesApi.list(currentPath,showHidden);
      const nodes=data.files.map(entry=>({entry,fullPath:`${currentPath}/${entry.name}`,loaded:false,expanded:false}));
      const refreshed=await restoreExpandedNodes(nodes,new Set(getExpandedPaths(tree)),showHidden,filesApi);
      if(sequence!==rootLoadSequence.current) return;
      setTree(refreshed);
      let keptDraft=!!snapshot && snapshot.editedContent!==snapshot.content;
      if(snapshot && !keptDraft) {
        const data=await filesApi.read(snapshot.path);
        if(sequence!==rootLoadSequence.current) return;
        const latest=tabsRef.current.find(tab=>tab.path===snapshot.path);
        if(latest && (latest.editedContent!==latest.content || latest.content!==snapshot.content)) keptDraft=true;
        setTabs(current=>current.map(tab=>tab.path!==snapshot.path || tab.content!==snapshot.content || tab.editedContent!==tab.content ? tab : {
          ...tab,content:data.content,editedContent:data.content,size:data.size,extension:data.extension,previewType:data.previewType,previewRevision:(tab.previewRevision || 0)+1,
        }));
      }
      setActionMessage({kind:'info',text:keptDraft ? '目录已刷新；当前文件有未保存修改，已保留编辑内容' : '目录和当前文件已刷新'});
      requestAnimationFrame(()=>{if(treeScrollRef.current && sequence===rootLoadSequence.current) treeScrollRef.current.scrollTop=scrollTop;});
    } catch(error) {if(sequence===rootLoadSequence.current) setActionMessage({kind:'error',text:getErrorMessage(error,'刷新失败')});}
    finally {refreshBusy.current=false;setRefreshing(false);}
  }

  const sortedTree=useMemo(()=>{
    const sort=(nodes:TreeNode[]):TreeNode[]=>[...nodes].sort((a,b)=>compareFileEntries(a.entry,b.entry,sortOrder))
      .map(node=>node.children ? {...node,children:sort(node.children)} : node);
    return sort(tree);
  },[tree,sortOrder]);

  const uploadFiles = useCallback(async (request: Pick<FileUploadRequest, 'files' | 'containsDirectories' | 'tree'>, directory: string) => {
    if (uploadBusy.current) return;
    if (readOnly || (request.containsDirectories && !request.tree)) {
      setUploadResult({ error: true, text: readOnly ? '当前为只读模式，不能上传文件' : '无法读取文件夹，请使用文件夹上传按钮' });
      return;
    }
    if (!request.files.length && !request.tree) return;
    uploadBusy.current = true;
    const sequence = rootLoadSequence.current;
    setUploadResult(null);
    if(request.tree) setUploadProgress({name:'正在读取文件夹…',index:0,total:0,percent:0,directory});
    let succeeded = 0;
    const failures: string[] = [];
    try {
      const parsed=request.tree ? await request.tree : {files:request.files.map(file=>({file,relativePath:file.webkitRelativePath || file.name})),directories:[]};
      if ('error' in parsed && parsed.error) throw new Error(parsed.error);
      const directories=new Set(parsed.directories);
      for (const item of parsed.files) {
        const parts=safeUploadPath(item.relativePath).split('/'); parts.pop();
        while(parts.length) {directories.add(parts.join('/')); parts.pop();}
      }
      const failedDirectories:string[]=[];
      for(const relative of [...directories].sort((a,b)=>a.split('/').length-b.split('/').length)) {
        safeUploadPath(relative);
        try {await filesApi.createDirectory(`${directory}/${relative}`);}
        catch(error) {failedDirectories.push(relative); failures.push(`${relative}：${getErrorMessage(error,'目录创建失败')}`);}
      }
      for (const [index, {file,relativePath}] of parsed.files.entries()) {
        const parent=relativePath.includes('/') ? `${directory}/${relativePath.slice(0,relativePath.lastIndexOf('/'))}` : directory;
        setUploadProgress({ name: relativePath, index: index + 1, total: parsed.files.length, percent: 0, directory:parent });
        try {
          if(failedDirectories.some(path=>relativePath.startsWith(path+'/'))) throw new Error('目标目录创建失败，已跳过');
          if (file.size > MAX_FILE_UPLOAD_BYTES) throw new Error('文件超过 50 MB 限制');
          await filesApi.upload(parent, file, (fraction) => {
            setUploadProgress({ name: relativePath, index: index + 1, total: parsed.files.length, percent: Math.round(fraction * 100), directory:parent });
          });
          succeeded++;
        } catch (error) {
          failures.push(`${relativePath}：${getErrorMessage(error, '上传失败')}`);
        }
      }
      if ((succeeded || directories.size) && sequence === rootLoadSequence.current) await refreshDirectory(directory);
      setUploadResult({
        error: failures.length > 0,
        text: `已上传 ${succeeded}/${parsed.files.length} 个文件到 ${directory}${directories.size ? `（包含 ${directories.size} 个目录）` : ''}${failures.length ? `；${failures.join('；')}` : ''}`,
      });
    } catch(error) {setUploadResult({error:true,text:getErrorMessage(error,'上传失败')});
    } finally {
      uploadBusy.current = false;
      setUploadProgress(null);
    }
  }, [readOnly, refreshDirectory, filesApi]);

  // The request identity prevents rerenders and StrictMode from uploading twice.
  useEffect(() => {
    if (!uploadRequest || lastUploadRequest.current === uploadRequest) return;
    lastUploadRequest.current = uploadRequest;
    void uploadFiles(uploadRequest, currentPath);
  }, [uploadRequest, currentPath, uploadFiles]);

  function dropDirectory(target: EventTarget) {
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-filepath]') : null;
    if (!row?.dataset.filepath) return currentPath;
    return row.dataset.filetype === 'directory' ? row.dataset.filepath : getParentDir(row.dataset.filepath);
  }

  function openContextMenuFor(e: React.MouseEvent, node: TreeNode | null) {
    e.preventDefault();
    e.stopPropagation();
    const isDir = node ? node.entry.type === 'directory' : true;
    const targetPath = node?.fullPath ?? currentPath;
    const containingDir = node ? (isDir ? node.fullPath : getParentDir(node.fullPath)) : currentPath;

    const items: ContextMenuItem[] = [];

    // Read-only users can still export or copy a selected entry.
    if (node) {
      items.push({
        kind: 'item',
        label: exportInProgress ? 'Export in progress…' : 'Export to local folder…',
        icon: exportInProgress
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Download className="w-3.5 h-3.5" />,
        onClick: () => handleExport(node.fullPath, isDir, node.entry.name),
        disabled: exportInProgress,
      });
      if (!readOnly) {
        items.push({
          kind: 'item',
          label: 'Cut',
          icon: <Scissors className="w-3.5 h-3.5" />,
          onClick: () => setClipboard({ kind: 'cut', path: node.fullPath, isDir }),
        });
      }
      items.push({
        kind: 'item',
        label: 'Copy',
        icon: <CopyIcon className="w-3.5 h-3.5" />,
        onClick: () => setClipboard({ kind: 'copy', path: node.fullPath, isDir }),
      });
    }

    if (!readOnly) {
      // Paste — only meaningful when target is a directory (or empty area)
      items.push({
        kind: 'item',
        label: clipboard ? `Paste ${clipboard.kind === 'cut' ? '(move)' : '(copy)'}` : 'Paste',
        icon: <Clipboard className="w-3.5 h-3.5" />,
        onClick: () => handlePaste(containingDir),
        disabled: !clipboard || (!isDir && !!node),
      });

      if (node) {
        items.push({ kind: 'separator' });
        items.push({
          kind: 'item',
          label: 'Rename',
          icon: <Edit3 className="w-3.5 h-3.5" />,
          onClick: () => setRenamingPath(node.fullPath),
        });
        items.push({
          kind: 'item',
          label: 'Delete',
          icon: <Trash2 className="w-3.5 h-3.5" />,
          danger: true,
          onClick: () => setPendingDelete({ path: targetPath, isDir }),
        });
      }
    }

    setContextMenu(items.length ? { x: e.clientX, y: e.clientY, items } : null);
  }

  function handleExport(path: string, isDirectory: boolean, name: string) {
    void startExportTransfer({ path, isDirectory, name, ...(projectId ? { projectId } : {}) });
  }

  async function submitRename(path: string, newName: string) {
    if (readOnly) { setRenamingPath(null); return; }
    setRenamingPath(null);
    try {
      const result = await filesApi.rename(path, newName);
      // If a tab was open for the renamed file, update its path
      setTabs(prev => prev.map(t => t.path === path ? { ...t, path: result.path, name: newName } : t));
      if (activeTabPath === path) setActiveTabPath(result.path);
      // Clear clipboard reference if it pointed at the renamed item
      if (clipboard?.path === path) setClipboard(null);
      await refreshDirectory(getParentDir(path));
      setActionMessage({ kind: 'info', text: `Renamed to ${newName}` });
    } catch (error) {
      setActionMessage({ kind: 'error', text: getErrorMessage(error, 'Failed to rename') });
    }
  }

  async function confirmDelete() {
    if (readOnly) { setPendingDelete(null); return; }
    if (!pendingDelete) return;
    const { path, isDir } = pendingDelete;
    setPendingDelete(null);
    try {
      await filesApi.delete(path);
      // Close any tab pointing at the deleted file/folder
      setTabs(prev => prev.filter(t => t.path !== path && !t.path.startsWith(path + '/')));
      if (activeTabPath === path || activeTabPath?.startsWith(path + '/')) setActiveTabPath(null);
      if (clipboard?.path === path) setClipboard(null);
      await refreshDirectory(getParentDir(path));
      setActionMessage({ kind: 'info', text: `Deleted ${isDir ? 'folder' : 'file'}` });
    } catch (error) {
      setActionMessage({ kind: 'error', text: getErrorMessage(error, 'Failed to delete') });
    }
  }

  async function handlePaste(destDir: string) {
    if (readOnly || !clipboard) return;
    const src = clipboard.path;
    const kind = clipboard.kind;
    const sourceParent = getParentDir(src);

    try {
      if (kind === 'cut') {
        await filesApi.move(src, destDir);
        // Update any open tab whose path is being moved
        const newBase = `${destDir}/${src.split('/').pop()}`;
        setTabs(prev => prev.map(t => {
          if (t.path === src) return { ...t, path: newBase };
          if (t.path.startsWith(src + '/')) return { ...t, path: newBase + t.path.slice(src.length) };
          return t;
        }));
        if (activeTabPath === src) setActiveTabPath(newBase);
        else if (activeTabPath?.startsWith(src + '/')) setActiveTabPath(newBase + activeTabPath.slice(src.length));
        setClipboard(null);
      } else {
        await filesApi.copy(src, destDir);
      }
      // Refresh both source and destination directory views
      if (sourceParent !== destDir) {
        await refreshDirectory(sourceParent);
      }
      await refreshDirectory(destDir);
      setActionMessage({ kind: 'info', text: kind === 'cut' ? 'Moved' : 'Copied' });
    } catch (error) {
      setActionMessage({ kind: 'error', text: getErrorMessage(error, `Failed to ${kind === 'cut' ? 'move' : 'copy'}`) });
    }
  }

  const activeExtension = activeTab?.extension;
  const activePreviewType = activeTab?.previewType ?? 'text';
  const extensions = useMemo(() => {
    const languageExtension = activeExtension ? getLanguageExtension(activeExtension) : null;
    return [EditorView.lineWrapping, EditorView.theme({
      '&': { fontSize: '14px' },
      '.cm-content': { lineHeight: '1.7', padding: '12px 0' },
      '.cm-line': { padding: '0 12px' },
    }), ...(languageExtension ? [languageExtension] : [])];
  }, [activeExtension]);

  const handleEditorChange = useCallback((value: string) => {
    if (activeTabPath) updateTab(activeTabPath, { editedContent: value });
  }, [activeTabPath, updateTab]);

  const treePanel = <>
      <div
        ref={treePanelRef}
        className="h-full min-w-0 flex flex-col shrink-0 relative"
        aria-label="文件上传区域"
        onDragOver={(event) => {
          if (!isFileDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = readOnly || uploadBusy.current ? 'none' : 'copy';
          setUploadTarget(dropDirectory(event.target));
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setUploadTarget(null);
        }}
        onDrop={(event) => {
          if (!isFileDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          setUploadTarget(null);
          void uploadFiles(droppedFiles(event.dataTransfer), dropDirectory(event.target));
        }}
        style={{
          width: treePanelWidth,
          maxWidth: workspace?'calc(100% - 4px)':undefined,
          background: 'var(--bg-primary)',
          boxShadow: uploadTarget ? 'inset 0 0 0 2px var(--accent)' : undefined,
        }}
      >
        {/* Path bar */}
        <form
          onSubmit={handlePathSubmit}
          className="flex items-center gap-1 px-2 py-1.5 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <button
            type="button"
            onClick={navigateUp}
            disabled={normalizeExplorerPath(currentPath) === normalizeExplorerPath(rootPath)}
            className="flex items-center justify-center rounded shrink-0 transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ width: 24, height: 24, color: 'var(--text-secondary)' }}
            title="Parent directory"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => navigateTo(rootPath)}
            className="flex items-center justify-center rounded shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ width: 24, height: 24, color: 'var(--text-secondary)' }}
            title="Project root"
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setTree([]);
              setRootLoaded(false);
              setShowHidden((value) => !value);
            }}
            className="flex items-center gap-1 px-1.5 h-6 rounded shrink-0 text-xs transition-colors hover:bg-[var(--bg-tertiary)]"
            style={{ color: showHidden ? 'var(--accent)' : 'var(--text-tertiary)' }}
            title={showHidden ? '隐藏点文件' : '显示点文件'}
            aria-label={showHidden ? '隐藏点文件' : '显示点文件'}
            aria-pressed={showHidden}
          >
            {showHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span className="sr-only">点文件</span>
          </button>
          <input
            aria-label="当前目录路径"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            className="flex-1 min-w-0 text-xs px-1.5 py-1 rounded"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              outline: 'none',
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            }}
            spellCheck={false}
          />
        </form>

        <div className="flex items-center gap-1 px-2 py-1 text-xs shrink-0" style={{borderBottom:'1px solid var(--border)'}}>
          <select aria-label="文件排序" value={sortOrder} onChange={event=>setSortOrder(event.target.value as FileSort)} className="min-w-0 flex-1 rounded px-1 py-1" style={{background:'var(--bg-secondary)',color:'var(--text-primary)'}}>
            <option value="name">名称排序</option><option value="modified_desc">修改时间：最新优先</option><option value="modified_asc">修改时间：最早优先</option>
          </select>
          <button type="button" aria-label="刷新目录和当前文件" title="刷新目录和当前文件（保留未保存编辑）" disabled={refreshing || !rootLoaded} onClick={()=>void refreshExplorer()} className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--bg-tertiary)]"><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /></button>
          {!readOnly && <>
            <button type="button" title="上传文件到当前目录" aria-label="上传文件" disabled={!!uploadProgress} onClick={()=>fileInputRef.current?.click()} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--bg-tertiary)]"><Upload className="h-3.5 w-3.5" /></button>
            <button type="button" title="上传文件夹到当前目录" aria-label="上传文件夹" disabled={!!uploadProgress} onClick={()=>folderInputRef.current?.click()} className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--bg-tertiary)]"><FolderOpen className="h-3.5 w-3.5" /></button>
            <input ref={fileInputRef} type="file" multiple className="hidden" aria-label="选择上传文件" onChange={event=>{void uploadFiles({files:Array.from(event.target.files || []),containsDirectories:false},currentPath);event.target.value='';}} />
            <input ref={folderInputRef} type="file" multiple {...{webkitdirectory:'',directory:''}} className="hidden" aria-label="选择上传文件夹" onChange={event=>{void uploadFiles({files:Array.from(event.target.files || []),containsDirectories:false},currentPath);event.target.value='';}} />
          </>}
        </div>

        {uploadTarget && (
          <div className="absolute bottom-0 inset-x-0 z-10 pointer-events-none px-2 py-2 text-xs break-all" style={{ color: 'var(--accent)', background: 'var(--bg-secondary)', borderTop: '1px solid var(--accent)' }}>
            {readOnly ? '只读模式，不能上传' : uploadProgress ? '正在上传，请稍候' : `松开上传到：${uploadTarget}`}
          </div>
        )}
        {uploadProgress && (
          <div role="status" className="px-2 py-2 text-xs space-y-1 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="truncate" title={uploadProgress.name}>上传 {uploadProgress.index}/{uploadProgress.total}：{uploadProgress.name}</div>
            <div className="truncate" title={uploadProgress.directory} style={{ color: 'var(--text-secondary)' }}>到 {uploadProgress.directory}</div>
            <progress aria-label="文件上传进度" className="w-full h-1.5" max={100} value={uploadProgress.percent} />
            <div>{uploadProgress.percent === 100 ? '服务器正在保存…' : `${uploadProgress.percent}%`}</div>
          </div>
        )}
        {uploadResult && (
          <div role={uploadResult.error ? 'alert' : 'status'} className="px-2 py-2 text-xs break-words shrink-0 max-h-32 overflow-y-auto" style={{ color: uploadResult.error ? 'var(--error)' : 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
            {uploadResult.text}
          </div>
        )}
        <div
          ref={treeScrollRef}
          aria-label="文件目录"
          className="flex-1 overflow-y-auto"
          onContextMenu={(e) => {
            // Entry rows stop propagation; remaining events include empty-state text.
            openContextMenuFor(e, null);
          }}
        >
        {sortedTree.map((node) => (
          <TreeItem
            key={node.fullPath}
            node={node}
            depth={0}
            onToggle={toggleDir}
            onFileClick={handleFileClick}
            onFileDoubleClick={handleFileDoubleClick}
            onContextMenu={openContextMenuFor}
            selectedPath={activeTabPath}
            renamingPath={renamingPath}
            onRenameSubmit={submitRename}
            onRenameCancel={() => setRenamingPath(null)}
            cutPath={clipboard?.kind === 'cut' ? clipboard.path : null}
          />
        ))}
        {tree.length === 0 && rootLoaded && (
          <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
            No files found
          </div>
        )}
        </div>
        {actionMessage && (
          <div
            className="px-2 py-1.5 text-xs shrink-0 truncate"
            style={{
              borderTop: '1px solid var(--border)',
              color: actionMessage.kind === 'error' ? 'var(--error)' : 'var(--text-secondary)',
              background: 'var(--bg-secondary)',
            }}
            title={actionMessage.text}
          >
            {actionMessage.text}
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={startDragging}
        role="separator" aria-label="调整文件树宽度" aria-orientation="vertical"
        className="shrink-0 h-full"
        style={{
          width: 4,
          cursor: 'col-resize',
          background: isDraggingRef.current ? 'var(--accent)' : 'var(--border)',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent, #4a9eff)')}
        onMouseLeave={(e) => { if (!isDraggingRef.current) e.currentTarget.style.background = 'var(--border)'; }}
      />

  </>;
  const fileTabs = tabs.length > 0 ? (

          <div
            className={workspace?"workspace-file-tabs":"flex items-center gap-0.5 px-1 py-0.5 shrink-0 overflow-x-auto"}
            style={workspace?undefined:{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
          >
            {tabs.map(tab => {
              const isActive = tab.path === activeTabPath && (!workspace || workspace.editorActive);
              const tabDirty = tab.editedContent !== tab.content;
              const isCompareSelected = compareSelecting === tab.path;
              const isCompareTarget = compareSelecting && compareSelecting !== 'waiting' && compareSelecting !== tab.path;

              return (
                <div
                  key={tab.path}
                  className={workspace?"workspace-tab group":"flex items-center rounded-md shrink-0 group"}
                  data-active={isActive}
                  style={{
                    background: isCompareSelected
                      ? 'rgba(88,166,255,0.2)'
                      : isActive && !compareSelecting
                      ? 'var(--bg-tertiary)'
                      : 'transparent',
                    outline: isCompareSelected ? '1px solid var(--accent)' : undefined,
                  }}
                >
                  <button
                    onClick={() => {
                      workspace?.onActivate();
                      if (compareSelecting) {
                        selectForCompare(tab.path);
                      } else {
                        setActiveTabPath(tab.path);
                      }
                    }}
                    onDoubleClick={() => {
                      if (!compareSelecting) updateTab(tab.path, { pinned: true });
                    }}
                    className={workspace?"workspace-tab-button":"flex items-center gap-1 pl-2.5 pr-0.5 py-1 text-xs transition-colors max-w-[160px]"}
                    style={{
                      color: isCompareSelected
                        ? 'var(--accent)'
                        : isActive
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                      fontStyle: tab.pinned ? 'normal' : 'italic',
                      cursor: compareSelecting ? 'crosshair' : undefined,
                    }}
                    title={compareSelecting
                      ? (isCompareSelected ? 'Selected for compare' : isCompareTarget ? `Compare with ${compareSelecting.split('/').pop()}` : 'Click to select')
                      : tab.path}
                  >
                    {tabDirty && <Circle className="w-2 h-2 shrink-0 fill-current" style={{ color: 'var(--accent)' }} />}
                    <File className="w-3 h-3 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                    <span className="truncate">{tab.name}</span>
                  </button>
                  {!compareSelecting && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
                      className={workspace?"workspace-tab-close":"p-0.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity mr-0.5"}
                      style={{ color: 'var(--text-secondary)' }}
                      title="Close"
                      aria-label={`关闭文件 ${tab.name}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
            {/* Compare button */}
            {!workspace && tabs.filter(tab => (tab.previewType ?? 'text') === 'text').length >= 2 && (
              <button
                onClick={startCompare}
                className="flex items-center gap-1 px-2 py-1 rounded-md shrink-0 text-xs transition-colors ml-1"
                style={{
                  color: compareState || compareSelecting ? 'var(--accent)' : 'var(--text-secondary)',
                  background: compareState || compareSelecting ? 'rgba(88,166,255,0.15)' : 'transparent',
                }}
                title={compareState ? 'Exit compare' : compareSelecting ? 'Cancel compare' : 'Compare two files'}
              >
                <GitCompareArrows className="w-3.5 h-3.5" />
                {compareSelecting === 'waiting' && <span>Pick 1st file</span>}
                {compareSelecting && compareSelecting !== 'waiting' && <span>Pick 2nd file</span>}
              </button>
            )}
          </div>
  ) : null;

  return (
    <div ref={containerRef} className="h-full flex">
      {workspace ? workspace.treeHost && createPortal(treePanel, workspace.treeHost) : treePanel}

      {/* File editor / preview with tab bar */}
      <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
        {/* Tab bar */}
        {workspace ? workspace.tabsHost && createPortal(fileTabs, workspace.tabsHost) : fileTabs}

        {/* Compare view */}
        {compareState && (
          <FileCompareView
            compareState={compareState}
            onApplyHunk={applyHunk}
            onSave={saveCompareChanges}
            onClose={() => { setCompareState(null); setCompareSelecting(null); }}
            saving={saving}
            saveMessage={saveMessage}
            currentHunk={compareHunk}
            onHunkNav={handleCompareHunkNav}
          />
        )}

        {/* Active tab file info bar + editor (hidden during compare) */}
        {!compareState && activeTab && (
          <>
            <div
              className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
              style={{
                borderBottom: '1px solid var(--border)',
                color: 'var(--text-secondary)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div className="flex items-center gap-2 truncate">
                <span className="truncate">{activeTab.path}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                {saveMessage && (
                  <span style={{ color: saveMessage === 'Saved' ? 'var(--success)' : 'var(--error)' }}>
                    {saveMessage}
                  </span>
                )}
                {(readOnly || activePreviewType !== 'text') && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                    只读
                  </span>
                )}
                {!readOnly && isDirty && (
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
                    style={{
                      background: 'var(--accent)',
                      color: 'var(--bg-primary)',
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <Save className="w-3 h-3" />
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                )}
                {isMarkdown && activePreviewType === 'text' && (
                  <button
                    onClick={() => updateTab(activeTab.path, {
                      viewMode: activeTab.viewMode === 'preview' ? 'edit' : 'preview',
                    })}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                    }}
                    title={activeTab.viewMode === 'preview' ? '编辑 Markdown 源码' : '可视编辑 Markdown'}
                  >
                    {activeTab.viewMode === 'preview' ? (
                      <><Pencil className="w-3 h-3" /> 源码</>
                    ) : (
                      <><Eye className="w-3 h-3" /> 可视编辑</>
                    )}
                  </button>
                )}
                <span>{formatSize(activeTab.size)}</span>
              </div>
            </div>

            {activePreviewType !== 'text' ? (
              <DocumentPreview
                key={`${activeTab.path}:${activeTab.previewRevision || 0}`}
                path={activeTab.path}
                type={activePreviewType}
                content={activeTab.content}
                filesApi={filesApi}
                onDownload={() => void startExportTransfer({ path: activeTab.path, name: activeTab.name, isDirectory: false, ...(projectId ? { projectId } : {}) })}
              />
            ) : isMarkdown && activeTab.viewMode === 'preview' ? (
              <div
                className="flex-1 overflow-auto p-4 prose-invert"
                style={{ color: 'var(--text-primary)' }}
              >
                {(() => {
                  const { meta, body } = splitFrontmatter(activeTab.editedContent);
                  const frontmatter = activeTab.editedContent.slice(0, activeTab.editedContent.length - body.length);
                  return (
                    <>
                      {meta.length > 0 && <FrontmatterPanel meta={meta} />}
                      {readOnly || activeTab.extension === 'mdx' ? <div className="markdown-preview explorer-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                          pre:MarkdownDiagramPre,
                          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} documentPath={activeTab.path} rootPath={rootPath} filesApi={filesApi} />,
                          a: ({ href, children }) => <a href={href} target={href && /^(https?:|mailto:|tel:|\/\/)/i.test(href)?'_blank':undefined} rel="noopener noreferrer" onClick={event=>{
                            event.preventDefault();
                            followDocumentLink(href||'',event.currentTarget.closest<HTMLElement>('.explorer-markdown')!,resolveMarkdownLocalPath,followDocumentFile);
                          }}>{children}</a>,
                        }}>
                          {body}
                        </ReactMarkdown>
                      </div> : <ErrorBoundary key={`${activeTab.path}:${activeTab.previewRevision || 0}`} label="Markdown 可视编辑器" fallback={() => (
                        <div role="alert" className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                          <p>可视编辑器加载失败。当前文件内容已保留，可切换到源码继续编辑。</p>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs">
                            <button type="button" onClick={() => updateTab(activeTab.path, { viewMode: 'edit' })} style={{ color: 'var(--accent)' }}>切换到源码</button>
                            <button type="button" onClick={() => window.location.reload()} style={{ color: 'var(--text-secondary)' }}>重新加载页面</button>
                          </div>
                        </div>
                      )}><Suspense fallback={<div role="status">正在加载可视编辑器…</div>}><MarkdownVisualEditor
                        key={`${activeTab.path}:${activeTab.previewRevision || 0}`}
                        value={body}
                        onChange={(markdown) => updateTab(activeTab.path, { editedContent: frontmatter + markdown })}
                        filesApi={filesApi}
                        resolveLocalPath={resolveMarkdownLocalPath}
                        onOpenFile={followDocumentFile}
                      /></Suspense></ErrorBoundary>}
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="flex-1 overflow-auto">
                <CodeMirror
                  key={activeTab.path}
                  value={activeTab.editedContent}
                  onChange={handleEditorChange}
                  readOnly={readOnly}
                  editable={!readOnly}
                  extensions={extensions}
                  theme={oneDark}
                  height="100%"
                  style={{ height: '100%' }}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                    highlightSelectionMatches: true,
                    bracketMatching: true,
                    closeBrackets: true,
                    autocompletion: true,
                    indentOnInput: true,
                  }}
                />
              </div>
            )}
          </>
        )}
        {fileLoading && !activeTab && !compareState && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-secondary)' }} />
          </div>
        )}
        {fileError && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--error)' }}>
            {fileError}
          </div>
        )}
        {!activeTab && !compareState && !fileLoading && !fileError && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'var(--text-secondary)' }}>
            Select a file to view its contents
          </div>
        )}
      </div>

      {contextMenu && createPortal(
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />, document.body
      )}

      {pendingDelete && createPortal(
        <ConfirmModal
          title={pendingDelete.isDir ? 'Delete folder?' : 'Delete file?'}
          message={
            pendingDelete.isDir
              ? `Permanently delete "${pendingDelete.path.split('/').pop()}" and all of its contents? This cannot be undone.`
              : `Permanently delete "${pendingDelete.path.split('/').pop()}"? This cannot be undone.`
          }
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />, document.body
      )}
    </div>
  );
}

/* ================================================================
   FileCompareView — split diff with per-hunk apply arrows
   ================================================================ */

function FileCompareView({
  compareState,
  onApplyHunk,
  onSave,
  onClose,
  saving,
  saveMessage,
  currentHunk,
  onHunkNav,
}: {
  compareState: CompareState;
  onApplyHunk: (hunkIndex: number, direction: 'left' | 'right') => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
  saveMessage: string | null;
  currentHunk: number;
  onHunkNav: (delta: number) => void;
}) {
  const rows = useMemo(() => parseSplitRows(compareState.diff), [compareState.diff]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);

  const leftName = compareState.leftPath.split('/').pop() || 'left';
  const rightName = compareState.rightPath.split('/').pop() || 'right';
  const totalHunks = compareState.hunks.length;

  const markers = rows.map(r => {
    if (r.leftType === 'removed' || r.rightType === 'added') {
      if (r.leftType === 'removed' && r.rightType === 'added') return 'modified' as const;
      if (r.leftType === 'removed') return 'removed' as const;
      return 'added' as const;
    }
    return null;
  });

  // Both columns and the apply arrows share each row's height and scroll position.
  useEffect(() => {
    const element = hunkRefs.current[currentHunk], scroller = scrollRef.current;
    if (!element || !scroller) return;
    const container = scroller.getBoundingClientRect();
    scroller.scrollTop = Math.max(0, scroller.scrollTop + element.getBoundingClientRect().top - container.top - container.height / 3);
  }, [currentHunk]);

  const hasChanges = compareState.appliedHunks.size > 0;

  // Track hunk header row indices for ref assignment
  let hunkRefIdx = -1;

  // Identify the first row of each hunk for placing apply buttons in the gutter
  const hunkFirstRows = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = 0; i < rows.length; i++) {
      const hi = rows[i].hunkIndex;
      if (hi !== null && !map.has(hi)) map.set(hi, i);
    }
    return map;
  }, [rows]);

  if (!compareState.diff) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 shrink-0"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            <strong>{leftName}</strong> vs <strong>{rightName}</strong>
          </span>
          <button onClick={onClose} className="text-xs px-2 py-1 rounded" style={{ color: 'var(--text-secondary)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          Files are identical
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar with hunk navigation */}
      <div
        className="flex items-center justify-between px-4 py-1.5 text-xs shrink-0"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
      >
        <div className="flex items-center gap-3">
          <span><strong style={{ color: 'var(--error)' }}>{leftName}</strong></span>
          <span>vs</span>
          <span><strong style={{ color: 'var(--success)' }}>{rightName}</strong></span>
        </div>
        <div className="flex items-center gap-2">
          {/* Hunk navigation */}
          <div className="flex items-center gap-1 mr-2">
            <button
              onClick={() => onHunkNav(-1)}
              disabled={totalHunks === 0}
              className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
              style={{ width: 22, height: 22, color: 'var(--text-secondary)' }}
              title="Previous difference"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <span style={{ color: 'var(--accent)', minWidth: 60, textAlign: 'center' }}>
              {totalHunks > 0 ? `${currentHunk + 1} / ${totalHunks}` : '0'}
            </span>
            <button
              onClick={() => onHunkNav(1)}
              disabled={totalHunks === 0}
              className="flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-tertiary)]"
              style={{ width: 22, height: 22, color: 'var(--text-secondary)' }}
              title="Next difference"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          </div>
          {saveMessage && (
            <span style={{ color: saveMessage === 'Saved' ? 'var(--success)' : 'var(--error)' }}>
              {saveMessage}
            </span>
          )}
          {hasChanges && (
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
              style={{ background: 'var(--accent)', color: 'var(--bg-primary)', opacity: saving ? 0.6 : 1 }}
            >
              <Save className="w-3 h-3" />
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10"
            style={{ color: 'var(--text-secondary)' }}
            title="Exit compare"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div ref={scrollRef} role="region" aria-label="文件内容对比" className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ fontFamily: MONO }}>
          <div className="w-full min-w-0">{rows.map((row, index) => {
            const applied = row.hunkIndex !== null ? compareState.appliedHunks.get(row.hunkIndex) : undefined;
            const current = row.hunkIndex === currentHunk;
            const header = row.leftType === 'header' && row.leftText.startsWith('@@');
            const keepLeft = applied === 'left' && row.leftType !== 'header' && row.leftType !== 'separator';
            let refCallback: ((element: HTMLDivElement | null) => void) | undefined;
            if (header) {
              const hunkIndex = ++hunkRefIdx;
              refCallback = (element) => { hunkRefs.current[hunkIndex] = element; };
            }
            const hunkStart = row.hunkIndex !== null && hunkFirstRows.get(row.hunkIndex) === index;
            return <div key={index} ref={refCallback} data-diff-row={index} className="diff-paired-row diff-with-actions">
              <SplitHalf num={row.leftNum} text={row.leftText} type={keepLeft && row.leftType === 'removed' ? 'normal' : row.leftType}
                isCurrentHunk={current} isEditable={false} />
              <div className="diff-apply-cell flex items-start justify-center gap-0.5 pt-0.5" style={{ background: current ? HUNK_HIGHLIGHT : 'var(--bg-secondary)' }}>
                {hunkStart && row.hunkIndex !== null && <>
                  <button onClick={() => onApplyHunk(row.hunkIndex!, 'left')} className="flex items-center justify-center rounded" title="Keep left (no change)"
                    style={{ width: 18, height: 16, background: applied === 'left' ? 'var(--success)' : 'var(--bg-tertiary)', color: applied === 'left' ? '#fff' : 'var(--text-secondary)', border: applied === 'left' ? 'none' : '1px solid var(--border)' }}><ArrowLeft className="h-3 w-3" /></button>
                  <button onClick={() => onApplyHunk(row.hunkIndex!, 'right')} className="flex items-center justify-center rounded" title="Accept right side"
                    style={{ width: 18, height: 16, background: applied === 'right' ? 'var(--success)' : 'var(--bg-tertiary)', color: applied === 'right' ? '#fff' : 'var(--text-secondary)', border: applied === 'right' ? 'none' : '1px solid var(--border)' }}><ArrowRight className="h-3 w-3" /></button>
                </>}
              </div>
              <SplitHalf num={keepLeft ? row.leftNum ?? row.rightNum : row.rightNum}
                text={keepLeft ? row.leftType === 'removed' ? row.leftText : row.rightType === 'added' ? row.leftText : row.rightText : row.rightText}
                type={keepLeft ? 'normal' : row.rightType} isCurrentHunk={current} isEditable={false} />
            </div>;
          })}</div>
        </div>
        <OverviewRuler markers={markers} scrollRef={scrollRef} />
      </div>
    </div>
  );
}
