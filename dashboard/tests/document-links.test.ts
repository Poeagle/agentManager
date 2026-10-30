import {describe,expect,it,vi} from 'vitest';
import {documentHeadingSlug,followDocumentLink,scrollDocumentFragment} from '../src/lib/document-links';
function scope() {const root=document.createElement('div');root.innerHTML='<h2>部署：当前交付</h2><p id="explicit">Target</p><h2>重复标题</h2><h2>重复标题</h2>';return root;}
describe('document links',()=>{
  it('opens a project file with its decoded heading fragment',()=>{
    const open=vi.fn();followDocumentLink('guide.md#%E9%83%A8%E7%BD%B2',scope(),()=>'/p/guide.md',open);expect(open).toHaveBeenCalledWith('/p/guide.md','部署');
  });
  it('jumps to headings within the current document without navigating the app URL',()=>{
    const root=scope(),scroll=vi.fn();root.children[0].scrollIntoView=scroll;
    const open=vi.fn();followDocumentLink('#部署当前交付',root,()=>null,open);expect(scroll).toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
    expect(documentHeadingSlug('Some **Heading**!')).toBe('some-heading');
  });
  it('supports explicit IDs and repeated heading suffixes',()=>{
    const root=scope();const explicit=vi.fn(),repeated=vi.fn();root.children[1].scrollIntoView=explicit;root.children[3].scrollIntoView=repeated;
    expect(scrollDocumentFragment(root,'explicit')).toBe(true);expect(explicit).toHaveBeenCalled();expect(scrollDocumentFragment(root,'重复标题-1')).toBe(true);expect(repeated).toHaveBeenCalled();
  });
  it('opens external destinations separately and ignores invalid or unsafe links',()=>{
    const open=vi.spyOn(window,'open').mockImplementation(()=>null);const file=vi.fn();
    followDocumentLink('https://example.com/help',scope(),()=>null,file);expect(open).toHaveBeenCalledWith('https://example.com/help','_blank','noopener,noreferrer');
    for(const source of ['javascript:alert(1)','data:text/html,x','broken.md#%zz'])followDocumentLink(source,scope(),()=>null,file);
    expect(open).toHaveBeenCalledTimes(1);expect(file).not.toHaveBeenCalled();open.mockRestore();
  });
});
