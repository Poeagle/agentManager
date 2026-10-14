import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitDiff, UnifiedDiff } from '../src/components/DiffComponents';

const before = '    source_password = os.environ.get("DDB_TEST_SOURCE_PASSWORD", os.environ.get("DDB_TEST_PASSWORD", ""))';
const after = '\tsecondary_password = os.environ.get("DDB_TEST_SECONDARY_PASSWORD", os.environ.get("DDB_TEST_PASSWORD", ""))';
const diff = ['diff --git a/test.py b/test.py', '--- a/test.py', '+++ b/test.py', '@@ -1,2 +1,3 @@ Config', `-${before}`, `+${after}`, '+extra = 1', ' unchanged = 2'].join('\n');
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
afterEach(() => {
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('wrapped content diffs', () => {
  it('preserves whitespace and pairs an added line with an empty original cell', () => {
    const edit = vi.fn();
    const view = render(<SplitDiff diff={diff} currentHunk={0} onHunkClick={vi.fn()} isEditable onLineEdit={edit} editedLines={new Map()} revertedHunks={new Set()} />);
    const editor = screen.getByRole('textbox', { name: '修改第 1 行' });
    expect(editor.textContent).toBe(after);
    fireEvent.blur(editor);
    expect(edit).not.toHaveBeenCalled();
    const addedRow = screen.getByRole('textbox', { name: '修改第 2 行' }).closest('[data-diff-row]')!;
    expect(addedRow.children).toHaveLength(2);
    expect(addedRow.children[0].textContent).toBe('');
    expect(view.container.querySelector('.diff-line')?.textContent).toContain('--- a/test.py');
  });
  it('uses logical file line numbers for editing and keeps reverted rows aligned', () => {
    const edit = vi.fn();
    const props = { diff, currentHunk: 0, onHunkClick: vi.fn(), isEditable: true, onLineEdit: edit, editedLines: new Map<number, string>(), revertedHunks: new Set<number>() };
    const { rerender } = render(<SplitDiff {...props} />);
    const editor = screen.getByRole('textbox', { name: '修改第 1 行' });
    editor.textContent = after + ' # reviewed'; fireEvent.blur(editor);
    expect(edit).toHaveBeenCalledWith(1, after + ' # reviewed');
    rerender(<SplitDiff {...props} revertedHunks={new Set([0])} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const restored = [...document.querySelectorAll('.diff-line')].filter((line) => line.textContent === before);
    expect(restored).toHaveLength(2);
    expect(screen.queryByText('extra = 1')).not.toBeInTheDocument();
  });
  it('keeps unified source lines intact and preserves hunk selection', () => {
    const select = vi.fn();
    const view = render(<UnifiedDiff diff={diff} currentHunk={0} onHunkClick={select} revertedHunks={new Set()} />);
    const line = [...view.container.querySelectorAll('.diff-line')].find((item) => item.textContent === '+' + after);
    expect(line).toBeDefined();
    fireEvent.click(screen.getByText('@@ -1,2 +1,3 @@ Config'));
    expect(select).toHaveBeenCalledWith(0);
  });
});
