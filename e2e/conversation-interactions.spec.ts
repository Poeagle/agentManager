import {test,expect} from '@playwright/test';
import {createServer} from 'http';
import {createRequire} from 'module';
import {mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
const require=createRequire(import.meta.url);
const {WebSocketServer}=require('../server/node_modules/ws');
const Database=require('../server/node_modules/better-sqlite3');

test('native questions and approvals survive refresh and submit through the actual authenticated bridge',async({page},testInfo)=>{
  const root=join(process.cwd(),'.test-data/e2e'),native='019ff001-7777-7777-8777-777777777777';
  const server=createServer(),wss=new WebSocketServer({server});const answers:any[]=[];let pending:any;let resumes=0;
  const question={id:3,method:'item/tool/requestUserInput',params:{threadId:native,turnId:'turn',itemId:'ask',isBlocking:true,questions:[{id:'scope',header:'部署范围',question:'选择部署环境',isOther:true,isSecret:false,options:[{label:'试用（推荐）',description:'隔离验证，不影响日常服务'},{label:'正式',description:'更新日常服务'}]},{id:'note',header:'备注',question:'补充说明',isOther:false,isSecret:false,options:null}]}};
  pending=question;
  wss.on('connection',(socket:any)=>socket.on('message',(bytes:any)=>{
    const frame=JSON.parse(bytes.toString());
    if(!frame.method){answers.push(frame);if(pending?.id===frame.id){pending=null;for(const client of wss.clients)client.send(JSON.stringify({method:'serverRequest/resolved',params:{threadId:native,requestId:frame.id}}));}return;}
    const result=frame.method==='thread/read'?{thread:{status:{type:'active',activeFlags:['waitingOnUserInput']}}}:frame.method==='thread/turns/list'?{data:[{id:'turn',status:'inProgress',items:[]}]}:{};
    if(frame.method==='thread/resume'){resumes++;if(pending)socket.send(JSON.stringify(pending));}
    socket.send(JSON.stringify({id:frame.id,result}));
  }));
  await new Promise<void>(resolve=>server.listen(join(root,'codex.sock'),resolve));
  try {
    const auth=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
    const projectPath=join(root,'interaction-project');mkdirSync(projectPath,{recursive:true});const {project}=await(await page.request.post('/api/projects',{data:{name:'交互验证',path:projectPath}})).json();
    const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
    const dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`rollout-${native}.jsonl`),JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'user_message',message:'请先询问部署环境，然后等待我的选择。'}})+'\n');
    const db=new Database(join(root,'agentmanager.db'));try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
    await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
    await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
    await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'交互验证'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
    await page.goto('/');const card=page.getByRole('region',{name:'Agent 需要你的回答'}).filter({visible:true});const submit=card.getByRole('button',{name:'提交回答'});
    await expect(card).toBeVisible();await expect(submit).toBeDisabled();await expect(page.getByRole('textbox',{name:'发送给当前 Agent 的消息'}).filter({visible:true})).toBeDisabled();
    await card.getByRole('radio',{name:/试用/}).check();await card.getByRole('textbox',{name:'补充说明'}).fill('刷新后仍保留');
    const beforeDisconnect=resumes;for(const client of wss.clients)client.terminate();await expect.poll(()=>resumes).toBeGreaterThan(beforeDisconnect);await expect(card.getByRole('textbox',{name:'补充说明'})).toHaveValue('刷新后仍保留');
    await page.reload();await expect(card.getByRole('radio',{name:/试用/})).toBeChecked();await expect(card.getByRole('textbox',{name:'补充说明'})).toHaveValue('刷新后仍保留');
    await expect(submit).toBeInViewport();
    await page.setViewportSize({width:390,height:844});await expect(submit).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('native-question-mobile.png')});await page.setViewportSize({width:1280,height:720});
    await page.screenshot({path:testInfo.outputPath('native-question.png')});
    await submit.click();await expect(card).toHaveCount(0);expect(answers).toEqual([{id:3,result:{answers:{scope:{answers:['试用（推荐）']},note:{answers:['刷新后仍保留']}}}}]);
    // Already answered native requests disappear again after browser refresh.
    await page.reload();await expect(page.getByText('事件通道已连接').filter({visible:true})).toBeVisible();await expect(card).toHaveCount(0);
    pending={id:'permission',method:'item/commandExecution/requestApproval',params:{threadId:native,turnId:'turn',itemId:'exec',reason:'验证构建结果',command:'npm run build',cwd:'/preview'}};
    for(const client of wss.clients)client.send(JSON.stringify(pending));
    const approval=page.getByRole('region',{name:'确认执行命令'}).filter({visible:true});await expect(approval).toContainText('npm run build');
    await page.reload();await expect(approval).toBeVisible();await expect(approval.getByRole('button',{name:'允许本次',exact:true})).toBeInViewport();await page.screenshot({path:testInfo.outputPath('native-approval.png')});
    await approval.getByRole('button',{name:'拒绝',exact:true}).click();await expect(approval).toHaveCount(0);expect(answers.at(-1)).toEqual({id:'permission',result:{decision:'decline'}});expect(answers).toHaveLength(2);
    await page.request.delete(`/api/sessions/${session.id}`);
  }finally {for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
