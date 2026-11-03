import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync,readFileSync} from 'fs';
import {join} from 'path';
test('Mermaid renders in chat, platform replies and editable Markdown; source and zoom remain available',async({page},info)=>{
 await page.addInitScript(()=>Object.defineProperty(window,'showSaveFilePicker',{value:undefined,configurable:true}));
 const dir=join(process.cwd(),'dashboard/.test-data/mermaid-proof');mkdirSync(dir,{recursive:true});
 const content='# 数据流程\n\n```mermaid\nflowchart TD\n A[客户端业务对象 / DataFrame / Vector] --> B[类型校验、批处理、序列化]\n B --> C[接收数据]\n C --> D[按分区拆分本批数据]\n D --> E[查找分区位置和副本]\n E --> F[向数据副本执行写入]\n F --> G[事务日志与缓存]\n G --> H[事务提交与版本确认]\n H --> I[向客户端返回成功]\n H --> J[后台排序、合并缓存]\n J --> K[写入 Level File]\n K --> L[更新引擎元数据]\n L --> M[后台合并]\n```\n\n```js\nconst n = 42;\n```';
 writeFileSync(join(dir,'mermaid-harness.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationMarkdown} from '../../src/components/ConversationMarkdown';import {AiReply} from '../../src/components/AiReply';import {MarkdownVisualEditor} from '../../src/components/MarkdownVisualEditor';import '../../src/components/SessionConversation.css';const content=${JSON.stringify(content)};window.changes=[];createRoot(document.getElementById('root')!).render(<><section id="chat"><ConversationMarkdown content={content} messageId="proof" projectId={null} onNavigate={()=>{}}/></section><section id="platform"><AiReply content={content}/></section><section id="editor"><MarkdownVisualEditor value={content} onChange={v=>window.changes.push(v)} filesApi={{}} resolveLocalPath={()=>null} onOpenFile={()=>{}}/></section></>);`);
 await page.route('**/mermaid-proof',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html data-theme="light"><head><style>body{font-family:Arial;--border:#ddd;--bg-primary:white;--accent:#2563eb;--text-secondary:#555}section{max-width:900px;margin:20px auto}</style></head><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><body><div id="root"></div><script type="module" src="/@fs'+join(dir,'mermaid-harness.tsx')+'"></script></body></html>'}));
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/mermaid-proof');
 for(const id of ['chat','platform','editor']){const section=page.locator(`#${id}`);await expect(section.getByRole('img',{name:'Mermaid 图表'})).toBeVisible();expect(await section.getByRole('img',{name:'Mermaid 图表'}).evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(50);await expect(section.getByText('const n = 42;',{exact:true})).toBeVisible();}
 // The full diagram scales to both the preview width and viewport height.
 // Keep aspect ratio and adapt again when the browser window changes.
 for(const id of ['chat','platform','editor']){
  const image=page.locator(`#${id}`).getByRole('img',{name:'Mermaid 图表'});
  const size=await image.evaluate(async(img:HTMLImageElement)=>{const svg=new DOMParser().parseFromString(await(await fetch(img.src)).text(),'image/svg+xml').documentElement;const box=svg.getAttribute('viewBox')!.split(/[ ,]+/).map(Number);return {width:img.width,height:img.height,naturalWidth:img.naturalWidth,viewWidth:box[2],viewportHeight:img.parentElement!.clientHeight,scrollHeight:img.parentElement!.scrollHeight};});
  expect(size.naturalWidth).toBeCloseTo(Math.ceil(size.viewWidth),0);expect(size.width).toBeLessThanOrEqual(size.naturalWidth+1);expect(size.height).toBeLessThanOrEqual(page.viewportSize()!.height*.55+1);expect(size.scrollHeight).toBeLessThanOrEqual(size.viewportHeight+1);
 }
 await page.setViewportSize({width:640,height:480});
 for(const id of ['chat','platform','editor']){
  const size=await page.locator(`#${id}`).getByRole('img',{name:'Mermaid 图表'}).evaluate((img:HTMLImageElement)=>({width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,ratio:img.naturalWidth/img.naturalHeight,available:img.parentElement!.clientWidth-24}));
  expect(size.height).toBeLessThanOrEqual(480*.55+1);expect(size.width).toBeLessThanOrEqual(size.available+1);expect(size.width/size.height).toBeCloseTo(size.ratio,2);
 }
 await page.setViewportSize({width:1280,height:720});
 expect(await page.evaluate(()=>(window as any).changes)).toEqual([]);
 await page.locator('#chat').getByRole('button',{name:'查看源码'}).click();await expect(page.locator('#chat .mermaid-diagram-source')).toContainText('flowchart TD');
 await page.locator('#platform').getByRole('button',{name:'放大 Mermaid 图表'}).click();
 const preview=page.getByRole('dialog',{name:'图片预览 · Mermaid 图表'});await expect(preview).toBeVisible();
 const dimensions=await preview.getByRole('img').evaluate((img:HTMLImageElement)=>({width:img.naturalWidth,height:img.naturalHeight}));
 await preview.getByRole('button',{name:'放大图片',exact:true}).click();
 for(const [format,extension,mime] of [['png','png','image/png'],['jpeg','jpg','image/jpeg'],['webp','webp','image/webp'],['svg','svg','image/svg+xml'],['original','svg','image/svg+xml']]){
  await preview.getByRole('combobox',{name:'图片下载格式'}).selectOption(format);
  const downloaded=page.waitForEvent('download');await preview.getByRole('button',{name:'下载图片',exact:true}).click();const download=await downloaded;
  expect(download.suggestedFilename()).toBe(`Mermaid 图表.${extension}`);
  const bytes=readFileSync((await download.path())!);
  if(extension==='svg'){expect(bytes.toString()).toContain('<svg');expect(bytes.toString()).toContain('viewBox=');}
  else{
   if(extension==='png')expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
   if(extension==='jpg')expect([...bytes.subarray(0,2)]).toEqual([255,216]);
   if(extension==='webp'){expect(bytes.subarray(0,4).toString()).toBe('RIFF');expect(bytes.subarray(8,12).toString()).toBe('WEBP');}
   const decoded=await page.evaluate(async({base64,mime})=>{const blob=await(await fetch(`data:${mime};base64,${base64}`)).blob(),image=await createImageBitmap(blob);return {width:image.width,height:image.height};},{base64:bytes.toString('base64'),mime});expect(decoded).toEqual(dimensions);
  }
 }
 await page.keyboard.press('Escape');
 await page.locator('#editor summary').click();const code=page.locator('#editor [data-node-view-content]');await expect(code.first()).toBeVisible();await page.screenshot({path:info.outputPath('mermaid-three-views.png'),fullPage:true});expect(errors).toEqual([]);
});
