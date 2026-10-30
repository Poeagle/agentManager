import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/components/FileExplorer';
import { api } from '../src/lib/api';

vi.mock('../src/components/MarkdownVisualEditor', () => ({
  MarkdownVisualEditor() { throw new TypeError("Cannot read properties of null (reading 'useRef')"); },
}));
vi.mock('@uiw/react-codemirror', async (original) => {
  const actual = await original<typeof import('@uiw/react-codemirror')>();
  return { ...actual, default: ({ value }: { value: string }) => <textarea aria-label="源码内容" value={value} readOnly /> };
});
vi.mock('../src/lib/api', async (original) => {
  const actual = await original<typeof import('../src/lib/api')>();
  return { ...actual, api: { ...actual.api, files: { ...actual.api.files, list: vi.fn(), read: vi.fn(), write: vi.fn() } } };
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(api.files.list).mockResolvedValue({ path: '/project', files: [{ name: 'README.md', type: 'file', size: 64, extension: 'md' }] });
  vi.mocked(api.files.read).mockResolvedValue({ path: '/project/README.md', content: '---\ntitle: Keep metadata\n---\n# Draft\n\nKeep all content.\n', extension: 'md', size: 64 });
});

it('contains a Markdown runtime failure and preserves the full document when switching to source', async () => {
  const user = userEvent.setup();
  render(<FileExplorer rootPath="/project" />);
  await user.click(await screen.findByRole('button', { name: 'README.md', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('当前文件内容已保留');
  expect(screen.queryByText(/failed to render/)).not.toBeInTheDocument();
  expect(within(screen.getByLabelText('文件上传区域')).getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '切换到源码' }));
  expect(await screen.findByRole('textbox', { name: '源码内容' })).toHaveValue('---\ntitle: Keep metadata\n---\n# Draft\n\nKeep all content.\n');
  expect(api.files.write).not.toHaveBeenCalled();
});
