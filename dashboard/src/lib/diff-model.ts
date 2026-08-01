export interface HunkInfo {
  index: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLines: string[];
  newLines: string[];
  oldContent: string[];
  newContent: string[];
}

export interface SplitRow {
  leftNum: number | null;
  leftText: string;
  leftType: 'normal' | 'removed' | 'header' | 'separator';
  rightNum: number | null;
  rightText: string;
  rightType: 'normal' | 'added' | 'header' | 'separator';
  hunkIndex: number | null;
}

export type MarkerType = 'added' | 'removed' | 'modified' | null;

export function parseHunks(diff: string): HunkInfo[] {
  const lines = diff.split('\n');
  const hunks: HunkInfo[] = [];
  let hunkIndex = -1;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        hunkIndex++;
        hunks.push({
          index: hunkIndex,
          oldStart: Number.parseInt(match[1]),
          oldCount: match[2] ? Number.parseInt(match[2]) : 1,
          newStart: Number.parseInt(match[3]),
          newCount: match[4] ? Number.parseInt(match[4]) : 1,
          oldLines: [],
          newLines: [],
          oldContent: [],
          newContent: [],
        });
      }
      continue;
    }

    if (hunkIndex < 0) continue;
    const hunk = hunks[hunkIndex];
    if (!hunk) continue;

    if (line.startsWith('-') && !line.startsWith('---')) {
      hunk.oldLines.push(line.slice(1));
      hunk.oldContent.push(line.slice(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.newLines.push(line.slice(1));
      hunk.newContent.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      hunk.oldContent.push(line.slice(1));
      hunk.newContent.push(line.slice(1));
    }
  }
  return hunks;
}

export function parseSplitRows(raw: string): SplitRow[] {
  const lines = raw.split('\n');
  const result: SplitRow[] = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let currentHunkIndex = -1;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.startsWith('diff --git')) {
      const name = extractFileName(line);
      result.push({ leftNum: null, leftText: name, leftType: 'separator', rightNum: null, rightText: name, rightType: 'separator', hunkIndex: null });
      continue;
    }

    if (line.startsWith('@@')) {
      currentHunkIndex++;
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        leftNumber = Number.parseInt(match[1]) - 1;
        rightNumber = Number.parseInt(match[2]) - 1;
      }
      result.push({ leftNum: null, leftText: line, leftType: 'header', rightNum: null, rightText: '', rightType: 'header', hunkIndex: currentHunkIndex });
      continue;
    }

    if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) {
      result.push({ leftNum: null, leftText: line, leftType: 'header', rightNum: null, rightText: '', rightType: 'header', hunkIndex: null });
      continue;
    }

    if (line.startsWith('-')) {
      const removed: string[] = [];
      const added: string[] = [];
      let nextIndex = index;
      while (nextIndex < lines.length && lines[nextIndex].startsWith('-')) {
        removed.push(lines[nextIndex].slice(1));
        nextIndex++;
      }
      while (nextIndex < lines.length && lines[nextIndex].startsWith('+')) {
        added.push(lines[nextIndex].slice(1));
        nextIndex++;
      }
      const rowCount = Math.max(removed.length, added.length);
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const hasLeft = rowIndex < removed.length;
        const hasRight = rowIndex < added.length;
        result.push({
          leftNum: hasLeft ? ++leftNumber : null,
          leftText: hasLeft ? removed[rowIndex] : '',
          leftType: hasLeft ? 'removed' : 'normal',
          rightNum: hasRight ? ++rightNumber : null,
          rightText: hasRight ? added[rowIndex] : '',
          rightType: hasRight ? 'added' : 'normal',
          hunkIndex: currentHunkIndex,
        });
      }
      index = nextIndex - 1;
      continue;
    }

    if (line.startsWith('+')) {
      rightNumber++;
      result.push({ leftNum: null, leftText: '', leftType: 'normal', rightNum: rightNumber, rightText: line.slice(1), rightType: 'added', hunkIndex: currentHunkIndex });
      continue;
    }

    if (line.length > 0 || index < lines.length - 1) {
      leftNumber++;
      rightNumber++;
      const text = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ leftNum: leftNumber, leftText: text, leftType: 'normal', rightNum: rightNumber, rightText: text, rightType: 'normal', hunkIndex: currentHunkIndex });
    }
  }
  return result;
}

export function extractFileName(diffLine: string): string {
  const match = diffLine.match(/diff --git a\/(.*?) b\//);
  return match ? match[1] : diffLine;
}

export function filterDiffToFile(diff: string, filePath: string): string {
  const lines = diff.split('\n');
  let capturing = false;
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      capturing = line.includes(`a/${filePath}`) || line.includes(`b/${filePath}`);
    }
    if (capturing) result.push(line);
  }
  return result.join('\n');
}

export function applyDiffDraft(
  fileContent: string,
  hunks: HunkInfo[],
  revertedHunks: ReadonlySet<number>,
  editedLines: ReadonlyMap<number, string>,
) {
  const lines = fileContent.split('\n');

  // Edits use line numbers from the current file, before any reverted hunk can
  // insert or remove lines and shift all following positions.
  for (const [lineNumber, newText] of editedLines) {
    if (lineNumber > 0 && lineNumber <= lines.length) lines[lineNumber - 1] = newText;
  }

  const hunksToRevert = [...revertedHunks]
    .map((index) => hunks[index])
    .filter((hunk): hunk is HunkInfo => hunk !== undefined)
    .sort((left, right) => right.newStart - left.newStart);

  for (const hunk of hunksToRevert) {
    lines.splice(hunk.newStart - 1, hunk.newCount, ...hunk.oldContent);
  }

  return lines.join('\n');
}

export function lineStyle(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return { color: 'var(--success)', bg: 'rgba(63,185,80,0.08)' };
  if (line.startsWith('-') && !line.startsWith('---')) return { color: 'var(--error)', bg: 'rgba(248,81,73,0.08)' };
  if (line.startsWith('@@')) return { color: 'var(--accent)', bg: 'transparent' };
  if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) return { color: 'var(--text-tertiary)', bg: 'transparent' };
  return { color: 'inherit', bg: 'transparent' };
}

export const GUTTER_W = 44;
export const ROW_H = 20;
export const MONO = "var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace)";
export const HUNK_HIGHLIGHT = 'rgba(234,179,8,0.08)';
