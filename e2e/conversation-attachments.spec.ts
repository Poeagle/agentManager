import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {createServer} from 'node:http';
let nativeServer:any,nativeWss:any,nativeInputs:any[]=[];
test.beforeEach(async()=>{nativeInputs=[];const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws');nativeServer=createServer();nativeWss=new WebSocketServer({server:nativeServer});nativeWss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const f=JSON.parse(bytes.toString());if(!f.method)return;if(f.method==='turn/start')nativeInputs.push(f.params);socket.send(JSON.stringify({id:f.id,result:f.method==='thread/read'?{thread:{status:{type:'idle'}}}:f.method==='thread/turns/list'?{data:[]}: {}}));}));await new Promise<void>(resolve=>nativeServer.listen(join(process.cwd(),'.test-data/e2e/codex.sock'),resolve));});
test.afterEach(async()=>{for(const client of nativeWss.clients)client.terminate();await new Promise<void>(resolve=>nativeWss.close(()=>resolve()));await new Promise<void>(resolve=>nativeServer.close(()=>resolve()));});

test('chat uploads pasted images and dropped files, retains drafts, and restores attachment history',async({page},testInfo)=>{
  test.setTimeout(90_000);
  const status=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data','e2e'),path=join(root,'attachments-project');mkdirSync(path,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'Chat Attachments',path}})).json();
  const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();
  const id='019ff001-7777-7777-8777-777777777778',directory=join(root,'home','.codex','sessions');mkdirSync(directory,{recursive:true});
  const log=join(directory,`rollout-attachments-${id}.jsonl`),entry=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
  writeFileSync(log,entry('event_msg',{type:'user_message',message:'附件测试'})+entry('event_msg',{type:'task_complete',last_agent_message:'可以发附件。'}));
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',id,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'附件测试'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.goto('/');
  const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true}),input=chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'}),send=chat.getByRole('button',{name:'发送消息',exact:true});
  await expect(chat.getByText('可以发附件。',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'对话',exact:true})).toHaveCSS('color','rgb(255, 255, 255)');
  await expect(send).toBeDisabled();
  await input.fill('前文后文');await input.evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild!,2);range.collapse(true);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
  await input.evaluate(node=>{
    const canvas=document.createElement('canvas');canvas.width=1008;canvas.height=275;const context=canvas.getContext('2d')!;context.fillStyle='#ffffff';context.fillRect(0,0,1008,275);context.fillStyle='#24304a';context.font='16px sans-serif';for(let index=0;index<8;index++)context.fillText('原图文字清晰度验证 · Token 2.3M · 工具 8次 / 8轮 · 保留图片原始比例',20,30+index*30);
    const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
    const data=new DataTransfer();data.items.add(new File([bytes],'截图.png',{type:'image/png'}));
    node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  });
  await expect(chat.locator('.session-chat-inline-attachment[data-status="ready"]')).toHaveCount(1);
  expect(await input.evaluate(node=>node.textContent?.replaceAll('\u200b',''))).toBe('前文图片 1后文');const geometry=await input.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node.firstChild!);const label=document.createRange();label.selectNodeContents(node.querySelector('[data-attachment-preview]')!);return {text:range.getBoundingClientRect().y,image:label.getBoundingClientRect().y};});expect(Math.abs(geometry.text-geometry.image)).toBeLessThan(3);await page.screenshot({path:testInfo.outputPath('draft-inline-image.png')});
  await input.evaluate(node=>{const data=new DataTransfer();data.items.add(new File(['attachment payload'],'说明.txt',{type:'text/plain'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));});
  await expect(chat.locator('.session-chat-inline-attachment[data-status="ready"]')).toHaveCount(2);
  const draftImage=chat.getByRole('button',{name:'预览待发送图片 截图.png'});await draftImage.hover();const hover=page.getByRole('tooltip',{name:'图片缩略预览 · 截图.png'});await expect(hover).toBeVisible();await expect.poll(()=>hover.getByRole('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(1008);const hoverBox=await hover.boundingBox();expect(hoverBox!.width).toBeGreaterThan(700);expect(hoverBox!.width).toBeLessThanOrEqual(960);expect(hoverBox!.x+hoverBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);await page.screenshot({path:testInfo.outputPath('hover-original-resolution.png')});expect(await input.evaluate(node=>node.textContent?.replaceAll('\u200b',''))).toBe('前文图片 1文件 1后文');await input.hover({position:{x:2,y:2}});await expect(hover).toHaveCount(0);await draftImage.click();const pendingPreview=page.getByRole('dialog',{name:'图片预览 · 截图.png'});await expect(pendingPreview).toBeVisible();await expect.poll(()=>pendingPreview.getByRole('img').evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(1008);const frameSize=await pendingPreview.boundingBox(),previewImage=await pendingPreview.getByRole('img').boundingBox();expect(frameSize!.width).toBeLessThan(1080);expect(frameSize!.height-previewImage!.height).toBeLessThan(200);await page.keyboard.press('Escape');await expect(input).toContainText('图片 1');
  await page.getByRole('button',{name:'原始终端',exact:true}).click();await expect(page.locator('.xterm').filter({visible:true})).toBeVisible();
  await page.getByRole('button',{name:'对话',exact:true}).click();await expect(input).toContainText('图片 1');
  await expect(send).toBeEnabled();
  let posted:any;
  await page.route(`**/api/sessions/${session.id}/input`,async route=>{posted=route.request().postDataJSON();await route.fulfill({response:await route.fetch()});});
  await send.click();await expect(input.locator('[data-attachment-id]')).toHaveCount(0);
  expect(posted.input).toBe('前文后文');expect(posted.attachments.map((item:any)=>item.offset)).toEqual([2,2]);expect(posted.attachments.map((item:any)=>item.kind)).toEqual(['image','file']);
  for(const attachment of posted.attachments)expect(attachment.path.startsWith(join(path,'.agentmanager','pastes')+'/')).toBe(true);
  expect(readFileSync(posted.attachments[1].path,'utf8')).toBe('attachment payload');
  const text=nativeInputs.at(-1).input[0].text;expect(text).toContain('前文[Image #1]后文');expect(nativeInputs.at(-1).input[0].text_elements).toEqual([{byteRange:{start:6,end:16},placeholder:'[Image #1]'}]);
  appendFileSync(log,entry('response_item',{type:'message',role:'user',content:[{type:'input_text',text},...posted.attachments.filter((item:any)=>item.kind==='image').flatMap((item:any,index:number)=>[{type:'input_text',text:`<image name=[Image #${index+1}] path="${item.path}">`},{type:'input_image',image_url:'data:image/png;base64,'}])]})+entry('event_msg',{type:'task_complete',last_agent_message:'已接收图片和文件。'}));
  await expect(chat.getByText('已接收图片和文件。',{exact:true})).toBeVisible();
  await expect(chat.getByRole('button',{name:'打开附件 截图.png'})).toHaveCount(1);
  await expect(chat).not.toContainText('agentmanager_attachments');
  await expect(chat.locator('.session-chat-message-attachment img')).toHaveCount(0);
  await page.route(`**/api/sessions/${session.id}/conversation?*`,async route=>{const response=await route.fetch(),body=await response.json();body.messages=body.messages.map((item:any)=>item.role==='user'&&item.attachments?.length?{...item,text:item.text+'\n\n'}:item);await route.fulfill({response,json:body});});
  await page.reload();await expect(chat.getByRole('button',{name:'打开附件 说明.txt'})).toHaveCount(1);
  await expect(chat.getByRole('button',{name:'打开附件 截图.png'})).toHaveCount(1);
  await input.fill('预览后保留草稿');
  const thumb=chat.getByRole('button',{name:'打开附件 截图.png'});await thumb.scrollIntoViewIfNeeded();await expect(thumb).toHaveText('图片 1');await expect(thumb.locator('xpath=ancestor::*[contains(@class,"session-chat-user-text")]')).toContainText('前文图片 1文件 1后文');const sentLayout=await thumb.evaluate(node=>{const text=node.previousSibling!,range=document.createRange();range.setStart(text,(text.textContent?.length||1)-1);range.setEnd(text,text.textContent?.length||1);const label=document.createRange();label.selectNodeContents(node);return {text:range.getBoundingClientRect().y,image:label.getBoundingClientRect().y};});expect(Math.abs(sentLayout.text-sentLayout.image)).toBeLessThan(3);await page.screenshot({path:testInfo.outputPath('sent-inline-image.png')});await expect(thumb.locator('img')).toHaveCount(0);
  const location=page.url(),tabs=page.context().pages().length,area=chat.locator('.session-chat-scroll'),position=await area.evaluate(node=>node.scrollTop);
  await thumb.hover();const sentHover=page.getByRole('tooltip',{name:'图片缩略预览 · 截图.png'});await expect(sentHover).toBeVisible();await expect.poll(()=>sentHover.getByRole('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(1008);expect(page.url()).toBe(location);await expect(input).toHaveText('预览后保留草稿');await thumb.click();await expect(sentHover).toHaveCount(0);const image=page.getByRole('dialog',{name:'图片预览 · 截图.png'});await expect(image).toBeVisible();await image.getByRole('button',{name:'放大图片'}).click();await expect(image.getByLabel('图片缩放比例')).toContainText('%');await page.screenshot({path:testInfo.outputPath('image-centered.png')});await page.keyboard.press('Escape');await expect(image).toHaveCount(0);expect(page.url()).toBe(location);expect(page.context().pages()).toHaveLength(tabs);await expect(input).toHaveText('预览后保留草稿');expect(await area.evaluate(node=>node.scrollTop)).toBe(position);
  await chat.getByRole('button',{name:'打开附件 说明.txt'}).click();const file=page.getByRole('dialog',{name:'文件预览 · 说明.txt'});await expect(file).toContainText('attachment payload');await page.keyboard.press('Control+w');await expect(file).toHaveCount(0);await expect(input).toHaveText('预览后保留草稿');
  writeFileSync(join(path,'REPORT.md'),'# 完整审查报告\n\n结果已经核对。\n');appendFileSync(log,entry('response_item',{type:'message',id:'report-link',role:'assistant',phase:'final_answer',internal_chat_message_metadata_passthrough:{turn_id:'report-turn'},content:[{type:'output_text',text:'报告已生成：[查看完整报告](REPORT.md)'}]}));await chat.getByRole('link',{name:'查看完整报告'}).click();const report=page.getByRole('dialog',{name:'文件预览 · REPORT.md'});await expect(report.getByRole('heading',{name:'完整审查报告'})).toBeVisible();await page.screenshot({path:testInfo.outputPath('file-centered.png')});await page.keyboard.press('Escape');await expect(report).toHaveCount(0);await expect(input).toHaveText('预览后保留草稿');
  await expect.poll(async()=>{const value=await(await page.request.get(`/api/sessions?project_id=${project.id}`)).json();return value.sessions.find((s:any)=>s.id===session.id)?.content_summary;}).toContain('报告已生成');
  const enhanceButton=chat.getByRole('button',{name:'优化当前输入',exact:true}),enhanceBox=await enhanceButton.boundingBox(),sendBox=await send.boundingBox();expect(enhanceBox!.x+enhanceBox!.width).toBeLessThanOrEqual(sendBox!.x);expect(Math.abs(enhanceBox!.y-sendBox!.y)).toBeLessThan(2);await expect(page.locator('.workspace-sidebar-button[aria-label="优化当前输入"]')).toHaveCount(0);let enhanceRequest:any;await page.route('**/api/prompt-enhancer/enhance',async route=>{enhanceRequest=route.request().postDataJSON();await route.fulfill({json:{prompt:'优化后的反馈',context:{requested_rounds:2,included_rounds:1}}});});await page.getByRole('button',{name:'优化当前输入',exact:true}).click();const enhance=page.getByRole('dialog',{name:'优化当前输入'});await expect(enhance.getByRole('textbox',{name:'优化结果'})).toHaveValue('优化后的反馈');expect(enhanceRequest).toMatchObject({session_id:session.id,prompt:'预览后保留草稿'});await expect(input).toHaveText('预览后保留草稿');await enhance.getByRole('button',{name:'应用到输入框'}).click();await expect(input).toHaveText('优化后的反馈');await expect(enhance).toHaveCount(0);
  await input.fill('保留这个草稿');
  await page.route(`**/api/sessions/${session.id}/paste-file`,route=>route.fulfill({status:500,json:{error:'模拟上传失败'}}));
  await chat.getByLabel('选择对话附件').setInputFiles({name:'failed.txt',mimeType:'text/plain',buffer:Buffer.from('failed upload')});
  await expect(chat.getByRole('alert')).toContainText('模拟上传失败');await expect(send).toBeDisabled();await expect(input).toContainText('保留这个草稿');
  await chat.getByRole('button',{name:'移除附件 failed.txt'}).click();await expect(send).toBeEnabled();
  await page.screenshot({path:testInfo.outputPath('attachments.png')});
  await page.request.delete(`/api/sessions/${session.id}`);
});

test('uploads selected and dropped directories as ZIP attachments with nested paths intact',async({page})=>{
 const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),projectPath=join(root,'directory-upload-project'),source=join(root,'folder-source');mkdirSync(projectPath,{recursive:true});mkdirSync(join(source,'子目录'),{recursive:true});writeFileSync(join(source,'说明.txt'),'目录说明');writeFileSync(join(source,'子目录','data.csv'),'a,b\n1,2');
 const {project}=await(await page.request.post('/api/projects',{data:{name:'目录上传',path:projectPath}})).json();const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
 const native='019ff001-7777-7777-8777-777777777779',logs=join(root,'home/.codex/sessions');mkdirSync(logs,{recursive:true});writeFileSync(join(logs,`rollout-${native}.jsonl`),JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'task_complete',last_agent_message:'可以上传目录。'}})+'\n');
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),{unzipSync,strFromU8}=require('../server/node_modules/fflate'),db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'目录上传'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 try{
  await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true}),editor=chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'});await expect(chat.getByText('可以上传目录。')).toBeVisible();await editor.fill('请检查这些目录');
  const uploaded=page.waitForResponse(response=>response.url().endsWith(`/sessions/${session.id}/paste-file`)&&response.request().method()==='POST');await chat.getByLabel('选择对话目录').setInputFiles(source);const result=await(await uploaded).json();
  await expect(chat.getByRole('button',{name:'预览待发送文件 folder-source.zip'})).toHaveAttribute('data-status','ready');
  const zip=unzipSync(readFileSync(result.path));expect(strFromU8(zip['folder-source/说明.txt'])).toBe('目录说明');expect(strFromU8(zip['folder-source/子目录/data.csv'])).toContain('1,2');await expect(editor).toContainText('请检查这些目录');
  const dropped=page.waitForResponse(response=>response.url().endsWith(`/sessions/${session.id}/paste-file`)&&response.request().method()==='POST');
  await editor.evaluate(node=>{
   const f={name:'note.txt',isDirectory:false,file:(done:(file:File)=>void)=>done(new File(['dropped content'],'note.txt'))};
   const directory=(name:string,batches:unknown[][])=>({name,isDirectory:true,createReader:()=>{let index=0;return{readEntries:(done:(files:unknown[])=>void)=>done(batches[index++]||[])}}});
   const entry=directory('拖入目录',[[directory('nested',[[f]])],[directory('empty',[])]]),transfer=new DataTransfer();transfer.items.add(new File([''],'placeholder'));
   Object.defineProperty(transfer,'items',{value:[{kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>null}]});node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  const dropResult=await(await dropped).json();await expect(chat.getByRole('button',{name:'预览待发送文件 拖入目录.zip'})).toHaveAttribute('data-status','ready');const second=unzipSync(readFileSync(dropResult.path));expect(strFromU8(second['拖入目录/nested/note.txt'])).toBe('dropped content');expect(Object.keys(second)).toContain('拖入目录/empty/');
  await chat.getByRole('button',{name:'发送消息',exact:true}).click();await expect.poll(()=>nativeInputs.length).toBe(1);expect(nativeInputs[0].input[0].text).toContain('folder-source.zip');expect(nativeInputs[0].input[0].text).toContain('拖入目录.zip');await expect(editor).toHaveText('');
 }finally{await page.request.delete(`/api/sessions/${session.id}`).catch(()=>{});}
});
