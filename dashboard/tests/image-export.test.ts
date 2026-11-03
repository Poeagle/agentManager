import {afterEach,describe,expect,it,vi} from 'vitest';
import {imageExportName,imageExportBlob,isSvgImage} from '../src/lib/image-export';

afterEach(()=>vi.unstubAllGlobals());
describe('image export',()=>{
  it('keeps format and filename consistent and detects local SVG previews',()=>{
    expect(imageExportName('/folder/流程.svg','jpeg')).toBe('流程.jpg');
    expect(imageExportName('流程.png','webp')).toBe('流程.webp');
    expect(imageExportName('Mermaid 图表','original','image/svg+xml')).toBe('Mermaid 图表.svg');
    expect(imageExportName('asset.dat','original')).toBe('asset.dat');
    expect(isSvgImage({name:'图表',src:'/api/files/preview?path=/project/flow.svg&project_id=p'})).toBe(true);
    expect(isSvgImage({name:'photo.png',src:'/photo.png'})).toBe(false);
  });
  it('preserves original bytes, rejects fake raster-to-SVG exports and reports fetch failures',async()=>{
    const original=new Blob(['original pixels'],{type:'image/png'});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,blob:async()=>original}));
    const image={name:'photo.png',src:'/photo.png'};
    expect(await imageExportBlob(image,'original')).toBe(original);
    await expect(imageExportBlob(image,'svg')).rejects.toThrow('仅矢量图片支持 SVG');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false}));
    await expect(imageExportBlob(image,'original')).rejects.toThrow('图片读取失败');
  });
});
