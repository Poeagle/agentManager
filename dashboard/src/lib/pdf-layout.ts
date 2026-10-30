export interface PdfPageSize {width:number;height:number}
export const PDF_PAGE_GAP=16;

/** Fit whole pages to the viewport, allowing two pages only when both remain
 * readable at the selected zoom. Landscape sheets need more horizontal space. */
export function pdfLayout(viewport:PdfPageSize,page:PdfPageSize,pageCount:number,zoom:number) {
  if(viewport.width<=0 || viewport.height<=0 || page.width<=0 || page.height<=0)return {columns:1 as const,pageWidth:0};
  const heightFitWidth=viewport.height*page.width/page.height;
  const readableWidth=Math.max(320,heightFitWidth*zoom);
  const columns=pageCount>1 && viewport.width>=readableWidth*2+PDF_PAGE_GAP?2:1;
  const columnWidth=(viewport.width-PDF_PAGE_GAP*(columns-1))/columns;
  return {columns,pageWidth:Math.max(1,Math.round(Math.min(columnWidth,heightFitWidth)*zoom))};
}
