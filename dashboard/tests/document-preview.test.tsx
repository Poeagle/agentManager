import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildDrawioPreview } from '../src/lib/drawio-preview';
import { columnName, parseDelimitedFile, parseSpreadsheetHtml } from '../src/lib/spreadsheet-preview';
import { SpreadsheetPreview } from '../src/components/SpreadsheetPreview';
import { DocumentPreview } from '../src/components/DocumentPreview';
import { api } from '../src/lib/api';

describe('friendly document previews', () => {
  it('preserves CSV quoting, embedded newlines, empty fields and escaped quotes', () => {
    expect(parseDelimitedFile('name,value\r\n"first\nsecond","quote ""yes"""\r\n,', 'data.csv')[0].rows)
      .toEqual([[{ text: 'name' }, { text: 'value' }], [{ text: 'first\nsecond' }, { text: 'quote "yes"' }], [{ text: '' }, { text: '' }]]);
    expect(parseDelimitedFile('a\tb\n1\t2', 'data.tsv')[0].rows[1]).toEqual([{ text: '1' }, { text: '2' }]);
  });

  it('bounds huge previews and rejects unclosed CSV quotes', () => {
    expect(parseDelimitedFile('a,b\n'.repeat(1001), 'data.csv')[0]).toMatchObject({ truncated: true });
    expect(parseDelimitedFile('a,b\n'.repeat(1001), 'data.csv')[0].rows).toHaveLength(1000);
    expect(() => parseDelimitedFile('a,"broken', 'data.csv')).toThrow('引号未闭合');
    expect(columnName(0)).toBe('A');
    expect(columnName(26)).toBe('AA');
  });

  it('extracts safe cell text and sheet names, never active HTML', () => {
    const sheets = parseSpreadsheetHtml('<h1>Revenue</h1><table><tr><td colspan="2">Hello<br>World<script>bad()</script><img src=x onerror=bad()></td></tr></table><h1>Costs</h1><table><tr><td>42</td></tr></table>');
    expect(sheets[0].name).toBe('Revenue');
    expect(sheets[0].rows[0][0]).toEqual({ text: 'Hello\nWorld', colSpan: 2, rowSpan: 1 });
    render(<SpreadsheetPreview sheets={sheets} />);
    expect(screen.getByText(/Hello/)).toHaveClass('whitespace-pre-wrap');
    fireEvent.change(screen.getByLabelText('工作表'), { target: { value: '1' } });
    expect(screen.getByText('42')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  it('isolates draw.io XML from executable scripts and disallows external requests', () => {
    const xml = '<mxGraphModel><root><mxCell value="&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/></root></mxGraphModel>';
    const html = buildDrawioPreview(xml, 'window.GraphViewer = {};');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('\\u003cmxGraphModel');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(() => buildDrawioPreview('<broken>', '')).toThrow('不是有效的');
  });

  it('renders CSV cells instead of a text editor', async () => {
    render(<DocumentPreview path="/project/data.csv" type="csv" content="item,value\nA,10" filesApi={api.files} onDownload={vi.fn()} />);
    expect(await screen.findByRole('table')).toBeVisible();
    expect(screen.getByText('10')).toBeVisible();
  });

  it('displays actionable conversion errors and keeps original-file download available', async () => {
    const download = vi.fn();
    render(<DocumentPreview path="/project/report.docx" type="word" content="" filesApi={{ ...api.files, preview: vi.fn().mockRejectedValue(new Error('缺少 Writer')) }} onDownload={download} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('缺少 Writer');
    fireEvent.click(screen.getByRole('button', { name: '下载原文件' }));
    expect(download).toHaveBeenCalledOnce();
  });
});
