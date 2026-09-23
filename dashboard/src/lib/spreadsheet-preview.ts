export interface PreviewCell { text: string; colSpan?: number; rowSpan?: number }
export interface PreviewSheet { name: string; rows: PreviewCell[][]; truncated: boolean }
const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;

/** Parse quoted CSV/TSV without evaluating formulas or inserting HTML. */
export function parseDelimitedFile(content: string, name: string): PreviewSheet[] {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < Math.min(content.length, 20_000); i++) {
    if (content[i] === '"') {
      if (inQuotes && content[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (content[i] === '\r' || content[i] === '\n') break;
      if (content[i] in counts) counts[content[i]]++;
    }
  }
  const delimiter = name.toLowerCase().endsWith('.tsv') ? '\t'
    : [',', ';', '\t'].sort((a, b) => counts[b] - counts[a])[0];
  const rows: PreviewCell[][] = [];
  let row: PreviewCell[] = [];
  let value = '';
  let quoted = false;
  let truncated = false;
  const cell = () => {
    if (row.length < MAX_COLUMNS) row.push({ text: value });
    else truncated = true;
    value = '';
  };
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"' && (quoted || value === '')) {
      if (quoted && content[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) cell();
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[i + 1] === '\n') i++;
      cell(); rows.push(row); row = [];
      if (rows.length >= MAX_ROWS && i < content.length - 1) { truncated = true; break; }
    } else value += char;
  }
  if (!truncated || rows.length < MAX_ROWS) {
    if (quoted) throw new Error('CSV 引号未闭合，无法预览表格');
    if (value || row.length) { cell(); rows.push(row); }
  }
  return [{ name, rows, truncated }];
}

/** Only text and bounded merge spans leave the converter HTML. No markup, links or scripts are rendered. */
export function parseSpreadsheetHtml(html: string): PreviewSheet[] {
  // Template contents remain inert, including images/frames with resource URLs.
  const template = document.createElement('template');
  template.innerHTML = html;
  const doc = template.content;
  const tables = Array.from(doc.querySelectorAll('table')).filter(table => !table.parentElement?.closest('table'));
  if (!tables.length) throw new Error('文档中没有可预览的工作表');
  return tables.slice(0, 100).map((table, index) => {
    let heading: Element | null = table.previousElementSibling;
    let name = '';
    for (let i = 0; heading && i < 3; i++, heading = heading.previousElementSibling) {
      const title = heading.matches('h1,h2,h3') ? heading : heading.querySelector('h1,h2,h3');
      if (title?.textContent?.trim()) { name = title.textContent.trim(); break; }
    }
    const allRows = Array.from(table.rows);
    let truncated = allRows.length > MAX_ROWS || tables.length > 100;
    const rows = allRows.slice(0, MAX_ROWS).map(row => {
      if (row.cells.length > MAX_COLUMNS) truncated = true;
      return Array.from(row.cells).slice(0, MAX_COLUMNS).map(cell => {
        const clone = cell.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script,style,iframe,object').forEach(node => node.remove());
        clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
        return { text: clone.textContent?.trim() || '', colSpan: Math.min(cell.colSpan, MAX_COLUMNS), rowSpan: Math.min(cell.rowSpan, MAX_ROWS) };
      });
    });
    return { name: name || `工作表 ${index + 1}`, rows, truncated };
  });
}

export function columnName(index: number): string {
  let result = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result;
  return result;
}
