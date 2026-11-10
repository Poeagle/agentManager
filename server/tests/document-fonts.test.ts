import {describe,it,expect} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {documentFontEnvironment,requestedDocumentFonts} from '../src/services/document-fonts.js';
const zip=(files:Record<string,string>)=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)]))));
describe('Office font inspection',()=>{
 it('follows used paragraph styles and defaults without reporting unused styles',()=>{
  const bytes=zip({'word/document.xml':'<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>loadTable</w:t></w:r></w:p></w:body></w:document>','word/styles.xml':'<w:styles><w:style w:styleId="Normal" w:default="1"><w:rPr><w:rFonts w:ascii="仿宋" w:eastAsia="仿宋"/></w:rPr></w:style><w:style w:styleId="Body"><w:basedOn w:val="Normal"/></w:style><w:style w:styleId="Unused"><w:rPr><w:rFonts w:ascii="Unused Font"/></w:rPr></w:style></w:styles>'});
  expect(requestedDocumentFonts(bytes,'docx')).toEqual({fonts:['仿宋'],checked:true});
 });
 it('does not claim complete verification for theme-only, invalid or oversized XML',()=>{
  expect(requestedDocumentFonts(zip({'word/document.xml':'<w:rFonts w:asciiTheme="minorHAnsi"/>'}),'docx').checked).toBe(false);
  expect(requestedDocumentFonts(Buffer.from('not zip'),'docx').checked).toBe(false);
  expect(requestedDocumentFonts(zip({'word/document.xml':' '.repeat(4*1024*1024+1)}),'docx').checked).toBe(false);
 });
 it('reports missing exact fonts without selecting a fallback',async()=>{
  const bytes=zip({'word/document.xml':'<w:document><w:r><w:rPr><w:rFonts w:ascii="Font That Cannot Exist"/></w:rPr></w:r></w:document>'});
  const environment=await documentFontEnvironment(bytes,'docx');
  expect(environment.report.missing).toEqual(['Font That Cannot Exist']);
  expect(environment.report.substitutions).toEqual([]);
  expect(environment.config).not.toContain('<alias');
 });
});
