/**
 * Shared diff rendering components used by GitPanel and FileExplorer.
 */
import { useState, useEffect, useRef, useMemo, forwardRef } from 'react';
import { FileDiff } from 'lucide-react';
import './DiffComponents.css';
import {
  extractFileName,
  GUTTER_W,
  HUNK_HIGHLIGHT,
  lineStyle,
  MONO,
  parseSplitRows,
  ROW_H,
  type MarkerType,
} from '../lib/diff-model';

/* ================================================================
   FileSeparator
   ================================================================ */

export function FileSeparator({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold" style={{ background: 'var(--accent)', color: '#fff', minHeight: 28 }}>
      <FileDiff className="w-3.5 h-3.5 shrink-0" />
      <span className="min-w-0 break-all">{name}</span>
    </div>
  );
}

/* ================================================================
   SplitHalf
   ================================================================ */

export const SplitHalf = forwardRef<HTMLDivElement, {
  num: number | null;
  text: string;
  type: string;
  isCurrentHunk: boolean;
  isEditable: boolean;
  isEdited?: boolean;
  onEdit?: (text: string) => void;
  onClick?: () => void;
}>(function SplitHalf({ num, text, type, isCurrentHunk, isEditable, isEdited, onEdit, onClick }, ref) {
  if (type === 'separator') {
    return (
      <div ref={ref} className="diff-half flex min-w-0 items-center px-2 text-xs font-semibold" style={{ minHeight: ROW_H + 8, background: 'var(--accent)', color: '#fff', letterSpacing: '0.02em' }}>
        <FileDiff className="w-3.5 h-3.5 mr-1.5 shrink-0" />
        <span className="truncate">{text}</span>
      </div>
    );
  }

  if (type === 'header') {
    return (
      <div ref={ref} className="diff-half diff-line text-xs leading-5 px-1" style={{
        minHeight: ROW_H,
        color: 'var(--accent)',
        background: isCurrentHunk ? HUNK_HIGHLIGHT : 'var(--bg-secondary)',
        cursor: onClick ? 'pointer' : undefined,
      }} onClick={onClick}>
        {text}
      </div>
    );
  }

  const isRemoved = type === 'removed';
  const isAdded = type === 'added';
  const baseBg = isRemoved ? 'rgba(248,81,73,0.12)' : isAdded ? 'rgba(63,185,80,0.12)' : 'transparent';
  const hunkBg = isCurrentHunk ? HUNK_HIGHLIGHT : 'transparent';
  const bg = isCurrentHunk && !isRemoved && !isAdded ? hunkBg : baseBg;
  const gutterBg = isRemoved ? 'rgba(248,81,73,0.2)' : isAdded ? 'rgba(63,185,80,0.2)' : 'var(--bg-secondary)';
  const textColor = isEdited ? 'var(--accent)' : isRemoved ? 'var(--error)' : isAdded ? 'var(--success)' : 'var(--text-primary)';
  const marker = isRemoved ? '-' : isAdded ? '+' : ' ';

  const handleBlur = (e: React.FocusEvent<HTMLSpanElement>) => {
    if (onEdit) {
      const newText = e.currentTarget.textContent ?? '';
      if (newText !== text) {
        onEdit(newText);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      (e.target as HTMLElement).blur();
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
  };

  return (
    <div ref={ref} className="diff-half flex min-w-0 text-xs" style={{ minHeight: ROW_H, background: bg, outline: isCurrentHunk ? `1px solid rgba(234,179,8,0.15)` : undefined }}>
      <span className="shrink-0 text-right pr-1.5 select-none leading-5" style={{ width: GUTTER_W, color: 'var(--text-tertiary)', background: gutterBg }}>
        {num ?? ''}
      </span>
      <span className="shrink-0 w-4 text-center select-none leading-5" style={{ color: textColor }}>{num !== null ? marker : ''}</span>
      <span
        className="diff-line flex-1 min-w-0 leading-5"
        style={{
          color: textColor,
          outline: 'none',
          cursor: isEditable ? 'text' : undefined,
          borderBottom: isEdited ? '1px dashed var(--accent)' : undefined,
        }}
        contentEditable={isEditable}
        role={isEditable ? 'textbox' : undefined}
        aria-label={isEditable ? `修改第 ${num} 行` : undefined}
        aria-multiline={isEditable ? false : undefined}
        suppressContentEditableWarning
        onBlur={handleBlur}
        onKeyDown={isEditable ? handleKeyDown : undefined}
        spellCheck={false}
      >
        {text}
      </span>
    </div>
  );
});

/* ================================================================
   OverviewRuler (minimap scrollbar)
   ================================================================ */

export function OverviewRuler({ markers, scrollRef, onJump }: {
  markers: MarkerType[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onJump?: (scrollTop: number) => void;
}) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const [viewportRatio, setViewportRatio] = useState({ top: 0, height: 1 });
  const [layout, setLayout] = useState<{ height: number; rows: Record<number, { top: number; bottom: number }> } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight) { setViewportRatio({ top: 0, height: 1 }); return; }
      setViewportRatio({ top: scrollTop / scrollHeight, height: clientHeight / scrollHeight });
    };
    const measureRows = () => {
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      const rows: Record<number, { top: number; bottom: number }> = {};
      for (const row of el.querySelectorAll<HTMLElement>('[data-diff-row]')) {
        const rect = row.getBoundingClientRect();
        rows[Number(row.dataset.diffRow)] = { top: rect.top - origin, bottom: rect.bottom - origin };
      }
      const height = el.scrollHeight;
      setLayout((previous) => previous?.height === height && Object.keys(previous.rows).length === Object.keys(rows).length
        && Object.entries(rows).every(([index, row]) => previous.rows[Number(index)]?.top === row.top && previous.rows[Number(index)]?.bottom === row.bottom)
        ? previous : { height, rows });
      update();
    };
    measureRows();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureRows);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [scrollRef, markers]);

  const handleClick = (e: React.MouseEvent) => {
    const ruler = rulerRef.current;
    const el = scrollRef.current;
    if (!ruler || !el) return;
    const rect = ruler.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    const target = ratio * el.scrollHeight - el.clientHeight / 2;
    const clamped = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
    if (onJump) onJump(clamped);
    else el.scrollTop = clamped;
  };

  if (markers.length === 0) return null;

  const bands: { type: MarkerType; start: number; end: number }[] = [];
  for (let i = 0; i < markers.length; i++) {
    if (!markers[i]) continue;
    const type = markers[i];
    let end = i;
    while (end + 1 < markers.length && markers[end + 1] === type) end++;
    bands.push({ type, start: i, end });
    i = end;
  }

  const total = markers.length;

  return (
    <div ref={rulerRef} onClick={handleClick}
      className="shrink-0 relative"
      style={{ width: 14, background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', cursor: 'pointer' }}>
      {bands.map((b, i) => {
        const first = layout?.rows[b.start], last = layout?.rows[b.end];
        if (layout?.height && (!first || !last)) return null;
        const top = `${(layout?.height && first ? first.top / layout.height : b.start / total) * 100}%`;
        const heightPct = (layout?.height && first && last ? (last.bottom - first.top) / layout.height : (b.end - b.start + 1) / total) * 100;
        const color = b.type === 'removed' ? 'rgba(248,81,73,0.8)'
          : b.type === 'added' ? 'rgba(63,185,80,0.8)'
          : 'rgba(88,166,255,0.8)';
        return (
          <div key={i} className="absolute left-0.5 right-0.5" style={{ top, height: `max(2px, ${heightPct}%)`, background: color, borderRadius: 1 }} />
        );
      })}
      <div className="absolute left-0 right-0 pointer-events-none" style={{
        top: `${viewportRatio.top * 100}%`,
        height: `max(8px, ${viewportRatio.height * 100}%)`,
        background: 'rgba(255,255,255,0.08)',
        borderTop: '1px solid rgba(255,255,255,0.15)',
        borderBottom: '1px solid rgba(255,255,255,0.15)',
      }} />
    </div>
  );
}

/* ================================================================
   UnifiedDiff
   ================================================================ */

export function UnifiedDiff({ diff, currentHunk, onHunkClick, revertedHunks }: {
  diff: string; currentHunk: number; onHunkClick: (idx: number) => void; revertedHunks: Set<number>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lines = diff.split('\n');

  const lineHunkMap = useMemo(() => {
    const map = new Map<number, number>();
    let hunkIdx = -1;
    let inHunk = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('@@')) {
        hunkIdx++;
        inHunk = true;
        map.set(i, hunkIdx);
        continue;
      }
      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        inHunk = false;
        continue;
      }
      if (inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
        map.set(i, hunkIdx);
      }
    }
    return map;
  }, [lines]);

  const markers = lines.map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return 'added' as const;
    if (line.startsWith('-') && !line.startsWith('---')) return 'removed' as const;
    return null;
  });

  useEffect(() => {
    const el = hunkRefs.current[currentHunk];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [currentHunk]);

  let hunkRefIdx = -1;

  return (
    <div className="flex-1 min-h-0 flex">
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden" style={{ fontFamily: MONO }}>
        <div className="w-full min-w-0">
          {lines.map((line, i) => {
            const isFileSep = line.startsWith('diff --git');
            if (isFileSep) {
              const fileName = extractFileName(line);
              return <div key={i} data-diff-row={i}><FileSeparator name={fileName} /></div>;
            }

            const hunkIdx = lineHunkMap.get(i);
            const isCurrentHunk = hunkIdx === currentHunk;
            const isHunkHeader = line.startsWith('@@');
            const isReverted = hunkIdx !== undefined && revertedHunks.has(hunkIdx);

            if (isReverted && !isHunkHeader) {
              if (line.startsWith('+') && !line.startsWith('+++')) return null;
              if (line.startsWith('-') && !line.startsWith('---')) {
                const displayLine = ' ' + line.slice(1);
                const { color: ctxColor } = lineStyle(displayLine);
                return (
                  <div key={i} data-diff-row={i} className="diff-line px-3 text-xs leading-5"
                    style={{ color: ctxColor, background: isCurrentHunk ? HUNK_HIGHLIGHT : 'transparent' }}>
                    {displayLine}
                  </div>
                );
              }
            }

            const { color, bg } = lineStyle(line);

            let refCallback: ((el: HTMLDivElement | null) => void) | undefined;
            if (isHunkHeader) {
              hunkRefIdx++;
              const idx = hunkRefIdx;
              refCallback = (el) => { hunkRefs.current[idx] = el; };
            }

            const highlightBg = isCurrentHunk ? HUNK_HIGHLIGHT : bg;

            return (
              <div
                key={i}
                data-diff-row={i}
                ref={refCallback}
                className="diff-line px-3 text-xs leading-5"
                style={{ color, background: highlightBg, cursor: isHunkHeader ? 'pointer' : undefined }}
                onClick={isHunkHeader && hunkIdx !== undefined ? () => onHunkClick(hunkIdx) : undefined}
              >
                {line}
              </div>
            );
          })}
        </div>
      </div>
      <OverviewRuler markers={markers} scrollRef={scrollRef} />
    </div>
  );
}

/* ================================================================
   SplitDiff with paired rows and a shared scroll viewport
   ================================================================ */

export function SplitDiff({ diff, currentHunk, onHunkClick, isEditable, onLineEdit, editedLines, revertedHunks }: {
  diff: string; currentHunk: number; onHunkClick: (idx: number) => void;
  isEditable: boolean; onLineEdit: (lineNum: number, text: string) => void; editedLines: Map<number, string>; revertedHunks: Set<number>;
}) {
  const rows = useMemo(() => parseSplitRows(diff), [diff]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);

  const markers = rows.map(r => {
    if (r.leftType === 'removed' || r.rightType === 'added') {
      if (r.leftType === 'removed' && r.rightType === 'added') return 'modified' as const;
      if (r.leftType === 'removed') return 'removed' as const;
      return 'added' as const;
    }
    return null;
  });

  useEffect(() => {
    const element = hunkRefs.current[currentHunk], scroller = scrollRef.current;
    if (!element || !scroller) return;
    const container = scroller.getBoundingClientRect();
    scroller.scrollTop = Math.max(0, scroller.scrollTop + element.getBoundingClientRect().top - container.top - container.height / 3);
  }, [currentHunk]);

  let hunkRefIdx = -1;
  return <div className="flex min-h-0 min-w-0 flex-1">
    <div ref={scrollRef} role="region" aria-label="左右内容对比" className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ fontFamily: MONO }}>
      <div className="w-full min-w-0">{rows.map((row, index) => {
        const hunkHeader = row.leftType === 'header' && row.leftText.startsWith('@@');
        const reverted = row.hunkIndex !== null && revertedHunks.has(row.hunkIndex) && !hunkHeader && row.leftType !== 'separator';
        if (reverted && row.leftNum === null && row.rightType === 'added') return null;
        let refCallback: ((element: HTMLDivElement | null) => void) | undefined;
        if (hunkHeader) {
          const hunkIndex = ++hunkRefIdx;
          refCallback = (element) => { hunkRefs.current[hunkIndex] = element; };
        }
        const edited = row.rightNum !== null ? editedLines.get(row.rightNum) : undefined;
        const selectHunk = hunkHeader && row.hunkIndex !== null ? () => onHunkClick(row.hunkIndex!) : undefined;
        return <div key={index} ref={refCallback} data-diff-row={index} className="diff-paired-row">
          <SplitHalf num={row.leftNum} text={row.leftText} type={reverted && row.leftType === 'removed' ? 'normal' : row.leftType}
            isCurrentHunk={row.hunkIndex === currentHunk} isEditable={false} onClick={selectHunk} />
          <SplitHalf num={reverted ? row.leftNum : row.rightNum} text={reverted ? row.leftText : edited ?? row.rightText}
            type={reverted ? 'normal' : row.rightType} isCurrentHunk={row.hunkIndex === currentHunk}
            isEditable={!reverted && isEditable && row.rightType !== 'header' && row.rightType !== 'separator' && row.rightNum !== null}
            isEdited={!reverted && edited !== undefined} onEdit={row.rightNum !== null ? (text) => onLineEdit(row.rightNum!, text) : undefined} onClick={selectHunk} />
        </div>;
      })}</div>
    </div>
    <OverviewRuler markers={markers} scrollRef={scrollRef} />
  </div>;
}
