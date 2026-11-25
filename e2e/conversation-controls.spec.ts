import {test,expect,type Locator} from '@playwright/test';
import {createServer} from 'http';
import {createRequire} from 'module';
import {appendFileSync,mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
const require=createRequire(import.meta.url),{WebSocketServer}=require('../server/node_modules/ws'),Database=require('../server/node_modules/better-sqlite3');
const themes = ['light', 'midnight', 'slate', 'nord', 'dracula', 'solarized'];

async function expectReadableAction(button: Locator, fontSize: number, height: number) {
 const style = await button.evaluate(element => {
  const css = getComputedStyle(element);
  const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const color = (value: string) => {
   pixel.clearRect(0, 0, 1, 1);
   pixel.fillStyle = value;
   pixel.fillRect(0, 0, 1, 1);
   return Array.from(pixel.getImageData(0, 0, 1, 1).data);
  };
  const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((total, channel, index) => {
   const value = channel / 255;
   return total + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  }, 0);
  const foreground = color(css.color);
  const background = color(css.backgroundColor);
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return { foreground, background, font: parseFloat(css.fontSize), height: element.getBoundingClientRect().height, contrast: (values[0] + 0.05) / (values[1] + 0.05) };
 });
 expect.soft(style.font, 'action font size').toBeGreaterThanOrEqual(fontSize);
 expect.soft(style.height, 'action height').toBeGreaterThanOrEqual(height);
 expect.soft(style.background[3], 'action has a visible fill').toBe(255);
 expect.soft(style.contrast, 'action text contrast').toBeGreaterThanOrEqual(4.5);
 return style;
}

test('model controls use native capabilities and a docked file stays readable while feedback is sent',async({page},testInfo)=>{
 const root=join(process.cwd(),'.test-data/e2e'),native='019ff001-1212-7212-8212-121212121212',path=join(root,'conversation-controls');mkdirSync(path,{recursive:true});const directory=join(root,'home/.codex/sessions');mkdirSync(directory,{recursive:true});const log=join(directory,`rollout-${native}.jsonl`);
 const record=(type:string,payload:unknown)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n';
 writeFileSync(join(path,'REPORT.md'),'# 审查报告\n\n```mermaid\nflowchart TD\n A[接收数据] --> B[事务提交]\n```\n\n'+Array.from({length:100},(_,i)=>`第 ${i+1} 条检查结果：文件可以在右侧阅读。\n\n`).join(''));
 writeFileSync(log,record('event_msg',{type:'user_message',message:'查看审查报告'})+[1,2,3].map(i=>record('event_msg',{type:'agent_message',message:`第 ${i} 条进展，正在核对文件。`,phase:'commentary'})).join('')+record('event_msg',{type:'task_complete',last_agent_message:'报告已完成：[查看审查报告](REPORT.md)'})+record('turn_context',{model:'model-a',effort:'high',approval_policy:'never',sandbox_policy:{type:'workspace-write'}})+record('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:500000},last_token_usage:{input_tokens:11000,cached_input_tokens:10000,output_tokens:1000,total_tokens:12000},model_context_window:40000}}));
 const modelKey=(name:string)=>JSON.stringify(['openai',name]);
 let working=false;const steered:any[]=[];
 let tier='default',model='model-a',effort='high',compacting=false;let queued:any[]=[];const methods:string[]=[];const inputs:any[]=[],server=createServer(),wss=new WebSocketServer({server});
 wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{const f=JSON.parse(bytes.toString());if(!f.id||!f.method)return;methods.push(f.method);let result:any={};
  if(f.method==='config/read')result={config:{model_provider:'openai',model:'model-a'}};
  if(f.method==='thread/resume')result={serviceTier:tier};
  if(f.method==='thread/read')result={thread:{id:native,status:{type:compacting||working?'active':'idle'},model,reasoningEffort:effort,modelProvider:'openai',cwd:path,cliVersion:'0.test'}};
  if(f.method==='model/list')result={data:[{model:'model-a',displayName:'Model A',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high',serviceTiers:[{id:'priority',name:'Fast',description:'Faster requests'}]},{model:'model-b',displayName:'Model B',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'low'}]};
  if(f.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:25,windowDurationMins:10080,resetsAt:1900000000}}};
  if(f.method==='turn/steer'){if(compacting){socket.send(JSON.stringify({id:f.id,error:{message:'cannot steer a compact turn',code:-32600}}));return;}steered.push(f.params);result={turnId:'work'};}
  if(f.method==='thread/turns/list')result={data:working?[{id:'work',status:'inProgress',itemsView:'summary',items:[]}]:compacting?[{id:'compact-turn',status:'inProgress',items:[{id:'compact-item',type:'contextCompaction'}]}]:[]};
  if(f.method==='thread/queue/list')result={data:queued};
  if(f.method==='thread/queue/add'){const item={id:`q-${queued.length}`,clientUserMessageId:f.params.clientUserMessageId,input:f.params.input};queued.push(item);result={queuedSubmission:item};for(const client of wss.clients)client.send(JSON.stringify({method:'thread/queue/changed',params:{threadId:native}}));}
  if(f.method==='thread/queue/delete'){const before=queued.length;queued=queued.filter(q=>q.id!==f.params.queuedSubmissionId);result={deleted:queued.length<before};for(const client of wss.clients)client.send(JSON.stringify({method:'thread/queue/changed',params:{threadId:native}}));}
  if(f.method==='thread/settings/update'){model=f.params.model;effort=f.params.effort;if(f.params.serviceTier!==undefined)tier=f.params.serviceTier;for(const client of wss.clients)client.send(JSON.stringify({method:'thread/settings/updated',params:{threadId:native,threadSettings:{model,effort,serviceTier:tier}}}));}
  if(f.method==='thread/compact/start'){compacting=true;for(const client of wss.clients){client.send(JSON.stringify({method:'turn/started',params:{threadId:native,turn:{id:'compact-turn',status:'inProgress'}}}));client.send(JSON.stringify({method:'item/started',params:{threadId:native,turnId:'compact-turn',item:{id:'compact-item',type:'contextCompaction'}}}));}}
  if(f.method==='turn/start'){inputs.push(f.params);model=f.params.model||model;effort=f.params.effort||effort;appendFileSync(log,record('event_msg',{type:'user_message',message:f.params.input[0].text})+record('event_msg',{type:'task_complete',last_agent_message:'已收到文件反馈。'}));}
  socket.send(JSON.stringify({id:f.id,result}));
 }));await new Promise<void>(r=>server.listen(join(root,'codex.sock'),r));let sessionId:string|undefined;
 try {
  const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const {project}=await(await page.request.post('/api/projects',{data:{name:'会话控制与侧边预览',path}})).json();const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}})).json();sessionId=session.id;
  const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'控制验证'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.route(`**/api/sessions/${session.id}/environments`, route => route.fulfill({ json: {
   current: 'native', environments: [
    { id: 'native', name: '当前账号', kind: 'native', enabled: true, can_control: true },
    { id: 'account:review', name: 'Review Account', kind: 'account', enabled: true, can_control: true },
   ],
  } }));
  await page.route(`**/api/sessions/${session.id}/environments/*/preflight`, route => route.fulfill({ json: {
   ok: true, checks: [{ stage: 'codex_authentication', ok: true, message: '已登录' }],
   models: [{ model: 'model-a', name: 'Model A', efforts: [{ value: 'high' }], defaultEffort: 'high' }],
  } }));
  await page.goto('/');const modelSelect=page.getByRole('combobox',{name:'选择模型'}),strength=page.getByRole('combobox',{name:'选择推理强度'}),input=page.getByRole('textbox',{name:'发送给当前 Agent 的消息'});await expect(modelSelect).toHaveValue(modelKey('model-a'));await expect(page.getByText('Context 40K | 30%',{exact:true})).toBeVisible();await expect(page.getByLabel('Weekly remaining 75%')).toHaveCount(0);
  await page.getByRole('button',{name:'开启 Fast 模式'}).click();await expect(page.getByRole('button',{name:'关闭 Fast 模式'})).toHaveAttribute('aria-pressed','true');expect(tier).toBe('priority');
  await page.getByRole('button',{name:'关闭 Fast 模式'}).click();await expect(page.getByRole('button',{name:'开启 Fast 模式'})).toHaveAttribute('aria-pressed','false');expect(tier).toBe('default');expect(inputs).toHaveLength(0);
  await page.getByRole('combobox', { name: '选择 Codex 账号环境' }).selectOption('account:review');
  const switchDialog = page.getByRole('dialog', { name: '保留上下文切换 Codex 环境' });
  const preflight = switchDialog.getByRole('button', { name: '预检连接、登录、模型与项目权限' });
  const cancelSwitch = switchDialog.getByRole('button', { name: '取消', exact: true });
  const confirmSwitch = switchDialog.getByRole('button', { name: '复制历史并切换' });
  await expect(confirmSwitch).toBeDisabled();
  await expectReadableAction(confirmSwitch, 13, 32);
  await expect.soft(preflight).toBeFocused({ timeout: 1000 });
  await preflight.click();
  await expect(confirmSwitch).toBeEnabled();
  await page.setViewportSize({ width: 360, height: 740 });
  for (const theme of themes) {
   await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
   const preflightStyle = await expectReadableAction(preflight, 13, 32);
   const cancelStyle = await expectReadableAction(cancelSwitch, 13, 32);
   const confirmStyle = await expectReadableAction(confirmSwitch, 13, 32);
   expect.soft(preflightStyle.foreground[2]).toBeGreaterThan(preflightStyle.foreground[0]);
   expect.soft(confirmStyle.background).not.toEqual(cancelStyle.background);
  }
  expect(await switchDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const cancelBounds = (await cancelSwitch.boundingBox())!;
  const confirmBounds = (await confirmSwitch.boundingBox())!;
  expect.soft(cancelBounds.y).toBe(confirmBounds.y);
  expect.soft(confirmBounds.x - (cancelBounds.x + cancelBounds.width)).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await cancelSwitch.click();
  await expect(switchDialog).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  const settings=(await (await page.request.get('/api/settings')).json()).settings;
  const warningPolicy={enabled:true,conditions:{operator:'and',conditions:[{type:'context_percent',value:30}]}};
  expect((await page.request.put('/api/settings',{data:{settings:{conversation_send_guard:JSON.stringify(warningPolicy)}}})).ok()).toBe(true);
  try{
   await input.fill('检查原样发送的消耗');
   await page.getByRole('button',{name:'发送消息',exact:true}).click();
   const guard=page.getByRole('dialog',{name:'发送前检查'});
   const warning=guard.getByText(/^原样发送时/);
   await expect(warning).toContainText('10,000 个输入 Token');
   await expect(warning).toContainText('金额暂无法估算');
   expect(await warning.evaluate(el=>{
    const [red,green,blue]=getComputedStyle(el).color.match(/[0-9.]+/g)!.map(Number);
    return red>green&&red>blue;
   })).toBe(true);
   await page.setViewportSize({width:390,height:844});
   await expect(warning).toBeVisible();
   expect(await guard.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   await guard.getByRole('button',{name:'取消',exact:true}).click();
   await expect(input).toHaveText('检查原样发送的消耗');
   expect(inputs).toHaveLength(0);
  }finally{
   await page.setViewportSize({width:1280,height:720});
   await page.request.put('/api/settings',{data:{settings:{conversation_send_guard:settings.conversation_send_guard}}});
  }
  working=true;for(const client of wss.clients)client.send(JSON.stringify({method:'turn/started',params:{threadId:native,turn:{id:'work',status:'inProgress'}}}));
  await input.fill('运行中实时插入');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect.poll(()=>steered.length).toBe(1);expect(steered[0].expectedTurnId).toBe('work');
  const inserted=page.locator('.session-chat-message.user').filter({hasText:'运行中实时插入'});
  await expect(inserted.getByRole('status',{name:'等待 Agent 接收'})).toBeVisible();
  await expect(inserted.getByRole('status',{name:'已发送'})).toHaveCount(0);
  for(const client of wss.clients)client.send(JSON.stringify({method:'item/completed',params:{threadId:native,turnId:'work',item:{type:'userMessage',id:'steered-message',clientId:steered[0].clientUserMessageId,content:steered[0].input}}}));
  await expect(inserted.getByRole('status',{name:'已发送'})).toBeVisible();
  await expect(page.getByText('运行中实时插入',{exact:true})).toHaveCount(1);await expect(input).toHaveText('');expect(queued).toHaveLength(0);
  working=false;for(const client of wss.clients)client.send(JSON.stringify({method:'turn/completed',params:{threadId:native,turn:{id:'work',status:'completed'}}}));await expect(page.getByRole('button',{name:'压缩',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'压缩',exact:true}).click();await expect.poll(()=>methods.includes('thread/compact/start')).toBe(true);expect(inputs).toHaveLength(0);
  await expect(page.getByText('Compacting context',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'压缩中…',exact:true})).toBeDisabled();await expect(page.getByText('已开始压缩，进度会在当前会话中显示。',{exact:true})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('compaction-running.png')});
  await input.fill('排队消息一');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(input).toHaveText('');await input.fill('排队消息二');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('排队中',{exact:true})).toHaveCount(2);expect(inputs).toHaveLength(0);expect(queued.map(q=>q.input[0].text)).toEqual(['排队消息一','排队消息二']);
  await input.fill('撤回这条消息');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('排队中',{exact:true})).toHaveCount(3);
  const queuedMessage = page.locator('article').filter({ hasText: '撤回这条消息' });
  const cancelQueue = queuedMessage.getByRole('button', { name: '取消排队', exact: true });
  await page.setViewportSize({ width: 360, height: 740 });
  for (const theme of themes) {
   await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
   const style = await expectReadableAction(cancelQueue, 12, 26);
   expect.soft(style.foreground[0]).toBeGreaterThan(style.foreground[2]);
  }
  const actionBounds = (await cancelQueue.boundingBox())!;
  const statusBounds = (await queuedMessage.getByText('排队中', { exact: true }).boundingBox())!;
  expect.soft(Math.abs(actionBounds.y + actionBounds.height / 2 - statusBounds.y - statusBounds.height / 2)).toBeLessThan(2);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 1280, height: 720 });
  await cancelQueue.click();await expect(page.getByText('撤回这条消息',{exact:true})).toHaveCount(0);expect(queued.map(q=>q.input[0].text)).toEqual(['排队消息一','排队消息二']);
  await page.reload();await expect(page.getByText('排队中',{exact:true})).toHaveCount(2);await expect(page.getByText('Compacting context',{exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('messages-queued-during-compaction.png')});compacting=false;
  const compactUsage={total_tokens:2400,input_tokens:2000,cached_input_tokens:1900,output_tokens:400,reasoning_output_tokens:200};
  appendFileSync(log,record('compacted',{message:'COMPACTION_PRIVATE_SUMMARY'})+
    record('token_usage_record',{turn_id:'compact-turn',response_id:'compact-response',usage:compactUsage})+
    record('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:500000},last_token_usage:compactUsage,model_context_window:40000}}));
  for(const client of wss.clients){client.send(JSON.stringify({method:'thread/tokenUsage/updated',params:{threadId:native,turnId:'compact-turn',tokenUsage:{last:{totalTokens:2400,inputTokens:2000,cachedInputTokens:1900,outputTokens:400,reasoningOutputTokens:200},total:{totalTokens:500000},modelContextWindow:40000}}}));client.send(JSON.stringify({method:'item/completed',params:{threadId:native,turnId:'compact-turn',item:{id:'compact-item',type:'contextCompaction'}}}));client.send(JSON.stringify({method:'thread/status/changed',params:{threadId:native,status:{type:'idle'}}}));}
  await expect(page.getByText('Context compaction complete',{exact:true})).toBeVisible();await expect(page.getByText('Context 40K | 6%',{exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('compaction-completed.png')});
  const drain=[...queued];queued=[];for(const [index,q] of drain.entries()){inputs.push(q);for(const client of wss.clients){client.send(JSON.stringify({method:'turn/started',params:{threadId:native,turn:{id:`queue-turn-${index}`,status:'inProgress'}}}));client.send(JSON.stringify({method:'item/completed',params:{threadId:native,turnId:`queue-turn-${index}`,item:{id:`queue-user-${index}`,type:'userMessage',clientId:q.clientUserMessageId,content:q.input}}}));client.send(JSON.stringify({method:'turn/completed',params:{threadId:native,turn:{id:`queue-turn-${index}`,status:'completed'}}}));client.send(JSON.stringify({method:'thread/queue/changed',params:{threadId:native}}));}}await expect(page.getByText('排队中',{exact:true})).toHaveCount(0);for(const text of ['排队消息一','排队消息二'])await expect(page.getByText(text,{exact:true})).toHaveCount(1);


  const progress=page.getByRole('region',{name:'codex 进展'});await expect(progress.locator('.session-chat-progress-entry')).toHaveCount(3);expect((await progress.boundingBox())!.height).toBeLessThan(210);await page.screenshot({path:testInfo.outputPath('compact-progress-controls.png')});
  await modelSelect.selectOption(modelKey('model-b'));await expect(strength).toHaveValue('low');await strength.selectOption('medium');await expect(page.getByText('已应用',{exact:true})).toBeVisible();expect(model).toBe('model-b');expect(effort).toBe('medium');expect(inputs).toHaveLength(2);
  await page.getByRole('button',{name:'Details',exact:true}).click();const details=page.getByRole('dialog',{name:'会话详情'});await expect(details.getByRole('rowheader',{name:'当前模型'}).locator('..')).toContainText('model-b');await expect(details.getByRole('rowheader',{name:'总量 Token',exact:true}).locator('..')).toContainText('14,400');await details.getByRole('tab',{name:'会话详情'}).click();await expect(details.getByRole('table',{name:'按模型用量'})).toContainText('model-a');await details.getByRole('tab',{name:'概览'}).click();await page.screenshot({path:testInfo.outputPath('session-details.png')});await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'压缩',exact:true})).toBeEnabled();expect(methods.filter(method=>method==='model/list')).toHaveLength(1);expect(methods.filter(method=>method==='account/rateLimits/read')).toHaveLength(0);
  await page.getByRole('button',{name:'Details',exact:true}).click();await expect(details.getByRole('row',{name:/缓存命中率/})).toContainText('95.0%');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('session-details-mobile.png')});await page.keyboard.press('Escape');await page.setViewportSize({width:1280,height:720});await page.request.put('/api/settings',{data:{settings:{app_theme:'dark'}}});await page.reload();await page.getByRole('button',{name:'Details',exact:true}).click();await expect(details.getByRole('row',{name:/缓存命中率/})).toContainText('95.0%');await page.screenshot({path:testInfo.outputPath('session-details-dark.png')});await page.keyboard.press('Escape');await page.request.put('/api/settings',{data:{settings:{app_theme:'light'}}});await page.reload();
  for(const client of wss.clients){client.send(JSON.stringify({method:'turn/started',params:{threadId:native,turn:{id:'report-turn',status:'inProgress'}}}));client.send(JSON.stringify({method:'item/completed',params:{threadId:native,turnId:'report-turn',item:{id:'report-answer',type:'agentMessage',phase:'final_answer',text:'报告已完成：[查看审查报告](REPORT.md)'}}}));client.send(JSON.stringify({method:'turn/completed',params:{threadId:native,turn:{id:'report-turn',status:'completed'}}}));}
  await input.fill('这里的检查结果需要补充依据。');await page.getByRole('link',{name:'查看审查报告'}).click();const modal=page.getByRole('dialog',{name:'文件预览 · REPORT.md'});await expect(modal.getByRole('heading',{name:'审查报告',exact:true})).toBeVisible();
  await expect(modal.getByRole('img',{name:'Mermaid 图表'})).toBeVisible();expect(await modal.getByRole('img',{name:'Mermaid 图表'}).evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(50);
  const reader=modal.locator('.markdown-preview').locator('..');await reader.evaluate(node=>{node.scrollTop=240;});const before=await reader.evaluate(node=>node.scrollTop);await modal.getByRole('button',{name:'显示到侧边'}).click();const side=page.getByRole('complementary',{name:'文件预览 · REPORT.md'});await expect(side).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(input).toHaveText('这里的检查结果需要补充依据。');expect((await input.boundingBox())!.x+(await input.boundingBox())!.width).toBeLessThanOrEqual((await side.boundingBox())!.x);expect(await side.locator('.markdown-preview').locator('..').evaluate(node=>node.scrollTop)).toBe(before);
  await input.fill('边看文件边反馈：这里的检查结果需要补充依据。');await page.screenshot({path:testInfo.outputPath('file-docked-feedback.png')});await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect.poll(()=>inputs.length).toBe(3);expect(inputs[2]).not.toHaveProperty('model');expect(inputs[2]).not.toHaveProperty('effort');await expect(page.getByRole('region',{name:'会话对话'}).getByText('已收到文件反馈。',{exact:true})).toBeVisible();await expect(side).toBeVisible();
  await side.getByRole('button',{name:'居中显示'}).click();await expect(modal).toBeVisible();expect(await modal.locator('.markdown-preview').locator('..').evaluate(node=>node.scrollTop)).toBe(before);await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);await expect(modelSelect).toHaveValue(modelKey('model-b'));
  const batch=page.getByRole('complementary',{name:'批量待发内容'}),mode=page.getByRole('combobox',{name:'发送模式'});
  await mode.selectOption('batch');await expect(batch).toHaveCount(0);
  await input.fill('按需显示的批量内容');await input.press('Enter');await expect(batch).toBeVisible();
  const divider=batch.getByRole('separator',{name:'调整批量待发区宽度'});const original=Number(await divider.getAttribute('aria-valuenow')),box=await divider.boundingBox();
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();await page.mouse.move(box!.x+box!.width/2-100,box!.y+box!.height/2,{steps:10});await page.mouse.up();
  const wider=Number(await divider.getAttribute('aria-valuenow'));expect(wider).toBeGreaterThan(original+90);expect(Math.abs((await batch.boundingBox())!.width-wider)).toBeLessThan(2);
  await page.reload();await expect(divider).toHaveAttribute('aria-valuenow',String(wider));
  await page.setViewportSize({width:390,height:844});await expect(divider).not.toBeVisible();await expect(batch).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('batch-mobile.png')});
  await page.setViewportSize({width:1280,height:720});await expect(divider).toHaveAttribute('aria-valuenow',String(wider));
  await page.screenshot({path:testInfo.outputPath('batch-resized.png')});
  await batch.getByRole('button',{name:'删除第 1 条消息'}).click();await expect(batch).toHaveCount(0);
  await input.fill('批量发送后自动收起');await input.press('Enter');await expect(divider).toHaveAttribute('aria-valuenow',String(wider));
  await batch.getByRole('button',{name:'发送批量内容',exact:true}).click();await expect.poll(()=>inputs.length).toBe(4);await expect(batch).toHaveCount(0);await expect(mode).toHaveValue('batch');
  await mode.selectOption('immediate');
  await page.route(`**/api/sessions/${session.id}/input-check`,route=>route.fulfill({json:{enabled:true,needs_confirmation:false,matched:false,native_id:native,can_new:true,can_compact:true,token:'fixture',context_tokens:1000,context_window:40000,context_percent:2.5,idle_minutes:0,observed_at:null}}));
  await input.fill('尚未发送的草稿');await page.getByRole('button',{name:'简要压缩',exact:true}).click();
  const brief=page.getByRole('dialog',{name:'简要压缩设置'});await expect(brief).toBeVisible();
  await expect(brief.getByRole('combobox',{name:'简要压缩账号'})).toHaveValue('');
  await expect(brief.getByRole('combobox',{name:'简要压缩模型'})).toHaveValue('');
  await expect(brief.getByRole('option',{name:'Model B'})).toBeAttached();
  await brief.getByRole('combobox',{name:'简要压缩模型'}).selectOption(modelKey('model-b'));
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await brief.getByRole('button',{name:'取消'}).click();await expect(input).toHaveText('尚未发送的草稿');
  await page.setViewportSize({width:1280,height:720});await page.unroute(`**/api/sessions/${session.id}/input-check`);
  await page.getByRole('button',{name:'新开',exact:true}).click();await expect(page.getByRole('dialog',{name:'在当前标签页新开会话'})).toContainText('永久删除旧会话记录和 Agent 原始对话文件');await page.getByRole('button',{name:'取消',exact:true}).click();await expect(input).toBeVisible();
  // Browser replacement contract; runtime preparation/rollback is exercised by
  // conversation-new.test.ts against the real manager lifecycle.
  const nextNative='019ff001-5656-7565-8565-565656565656';writeFileSync(join(directory,`rollout-${nextNative}.jsonl`),record('session_meta',{id:nextNative}));
  let finishNewSession!:()=>void;
  const creating=new Promise<void>(resolve=>{finishNewSession=resolve;});
  await page.route(`**/api/sessions/${session.id}/new-conversation`,async route=>{
    await creating;
    const db=new Database(join(root,'agentmanager.db'));
    try{
      db.prepare("UPDATE sessions SET codex_session_id=?,task='新会话' WHERE id=?").run(nextNative,session.id);
      const row=db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id);
      await route.fulfill({json:{ok:true,session:row,previous_conversation_deletion:'pending'}});
    }finally{db.close();}
  });
  try{
    await input.fill('新会话中的未发送草稿');
    await page.getByRole('button',{name:'新开',exact:true}).click();
    await page.getByRole('button',{name:'停止旧会话并新开'}).click();
    await expect(page.getByRole('dialog',{name:'在当前标签页新开会话'})).toHaveCount(0);
    await expect(page.getByText('正在新开会话…',{exact:true})).toBeVisible();
    await expect(input).toHaveText('新会话中的未发送草稿');
    await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
  }finally{finishNewSession();}
  await expect(page.getByRole('link',{name:'查看审查报告'})).toHaveCount(0);
  await expect(input).toHaveText('新会话中的未发送草稿');
  await expect(page.getByRole('button',{name:'新开',exact:true})).toBeVisible();
  expect(inputs).toHaveLength(4);
 }finally {try{if(sessionId)await page.request.delete(`/api/sessions/${sessionId}`,{timeout:5000}).catch(()=>{});}finally{for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));}}
});
