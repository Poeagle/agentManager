import {beforeEach,expect,it,vi} from 'vitest';
import {buildHtmlPreview} from '../src/lib/html-preview';
import type {api} from '../src/lib/api';
const read=vi.fn(),preview=vi.fn();const files={read,preview} as unknown as typeof api.files;
beforeEach(()=>{read.mockReset();preview.mockReset();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn(()=> 'blob:image'),revokeObjectURL:vi.fn()}));});
it('bundles local styles and scripts, isolates the document and blocks project escapes',async()=>{
 read.mockImplementation(async(path:string)=>({content:path.endsWith('.css')?'h1{color:blue}':'window.previewLoaded=true;'}));preview.mockResolvedValue(new Blob(['svg'],{type:'image/svg+xml'}));
 const result=await buildHtmlPreview('<html><head><link rel="stylesheet" href="style.css"></head><body><h1>网页</h1><script src="main.js"></script><img src="assets/diagram.svg"><img src="../../private.png"></body></html>','/project/index.html','/project',files,new AbortController().signal);
 const doc=new DOMParser().parseFromString(result.html,'text/html');expect(doc.querySelector('script[src]')?.getAttribute('src')).toMatch(/^data:text\/javascript/);expect(doc.querySelector('link')?.getAttribute('href')).toMatch(/^data:text\/css/);expect(doc.querySelector('img')?.getAttribute('src')).toBe('blob:image');expect(doc.querySelectorAll('img')[1].hasAttribute('src')).toBe(false);expect(preview).toHaveBeenCalledTimes(1);expect(result.html).toContain("connect-src blob: data:");result.dispose();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image');
});
it('does not fetch external URLs or unsafe embedded frames',async()=>{
 const result=await buildHtmlPreview('<base href="https://outside.test/"><iframe src="/private"></iframe><img src="https://outside.test/a.png"><form action="/api/settings"></form>','/project/index.html','/project',files,new AbortController().signal);
 expect(read).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();expect(result.html).not.toContain('<iframe');expect(result.html).toContain("form-action 'none'");expect(result.warnings).toContain('外部资源');
});
