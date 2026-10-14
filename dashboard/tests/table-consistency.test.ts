import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const components = join(dirname(fileURLToPath(import.meta.url)), '../src/components');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name)) : entry.name.endsWith('.tsx') ? [join(directory, entry.name)] : []);
}

it('keeps platform table structures and expand controls in the shared component', () => {
  const violations: string[] = [];
  for (const path of sources(components)) {
    const file = relative(components, path);
    // The spreadsheet viewer renders document cells, rather than a platform list.
    if (file === 'table/DataTable.tsx' || file === 'table/TableActions.tsx' || file === 'SpreadsheetPreview.tsx') continue;
    const source = readFileSync(path, 'utf8');
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree);
        if (['table', 'thead', 'tbody', 'TableColumnHeader'].includes(tag)) violations.push(`${file}: independent ${tag}`);
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          if (tag === 'td' && attribute.name.getText(tree) === 'colSpan') violations.push(`${file}: independent detail/state row`);
          if (attribute.name.getText(tree) === 'className' && attribute.initializer && ts.isStringLiteral(attribute.initializer)
            && /\b(table-wrap|data-table|row-expand|detail-cell|compact-table|table-actions|table-button)\b/.test(attribute.initializer.text)) {
            violations.push(`${file}: independent table styling`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  expect(violations).toEqual([]);
});
