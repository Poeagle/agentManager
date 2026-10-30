import {describe,expect,it} from 'vitest';
import {pdfLayout,PDF_PAGE_GAP} from '../src/lib/pdf-layout';
const portrait={width:595,height:842},landscape={width:842,height:595};
describe('adaptive PDF page layout',()=>{
  it('shows portrait pages side by side when the window fits two whole pages',()=>{
    const layout=pdfLayout({width:1440,height:700},portrait,10,1);
    expect(layout.columns).toBe(2);expect(layout.pageWidth*2+PDF_PAGE_GAP).toBeLessThanOrEqual(1440);expect(layout.pageWidth*842/595).toBeLessThanOrEqual(701);
  });
  it('keeps narrow windows and one-page documents in single-page layout',()=>{
    expect(pdfLayout({width:358,height:700},portrait,10,1).columns).toBe(1);
    expect(pdfLayout({width:1440,height:700},portrait,1,1).columns).toBe(1);
  });
  it('uses the paper aspect ratio and both viewport dimensions',()=>{
    expect(pdfLayout({width:1440,height:700},landscape,4,1).columns).toBe(1);
    expect(pdfLayout({width:2200,height:700},landscape,4,1).columns).toBe(2);
    expect(pdfLayout({width:1000,height:1200},portrait,4,1).columns).toBe(1);
    expect(pdfLayout({width:1000,height:600},portrait,4,1).columns).toBe(2);
  });
  it('switches to one page when zooming in, and keeps mobile pages within the viewport',()=>{
    expect(pdfLayout({width:1100,height:700},portrait,10,1).columns).toBe(2);
    expect(pdfLayout({width:1100,height:700},portrait,10,1.5).columns).toBe(1);
    const phone=pdfLayout({width:322,height:600},portrait,10,1);expect(phone.pageWidth).toBeLessThanOrEqual(322);
  });
  it('waits for measured sizes instead of creating invalid canvases',()=>{
    expect(pdfLayout({width:0,height:0},portrait,10,1)).toEqual({columns:1,pageWidth:0});
  });
});
