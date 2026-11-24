import {expect,test} from '@playwright/test';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('a quoted reply remains linked to the original message after native history reload',async({page})=>{
  const auth=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data/e2e');
  const projectPath=join(root,'quote-project');
  mkdirSync(projectPath,{recursive:true});
  const {project}=await(await page.request.post('/api/projects',{data:{name:'引用测试',path:projectPath}})).json();
  const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
  const native='019ff001-8888-7888-8888-888888888888';
  const directory=join(root,'home/.codex/sessions');
  mkdirSync(directory,{recursive:true});
  const log=join(directory,`rollout-quote-${native}.jsonl`);
  const record=(role:'user'|'assistant',id:string,text:string)=>JSON.stringify({
    type:'response_item',timestamp:new Date().toISOString(),payload:{
      type:'message',id,role,phase:role==='assistant'?'final_answer':undefined,
      content:[{type:role==='assistant'?'output_text':'input_text',text}],
    },
  })+'\n';
  const original='先核对窄屏布局，再检查键盘操作。';
  writeFileSync(log,record('user','question','请审查页面。')+record('assistant','answer',original));
  const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3');
  const db=new Database(join(root,'agentmanager.db'));
  try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'引用测试'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
  await page.routeWebSocket('**/conversation/stream*',socket=>socket.send(JSON.stringify({type:'snapshot',messages:[],busy:false,stage:'idle'})));
  let submitted:{input:string;client_id:string}|undefined;
  await page.route(`**/api/sessions/${session.id}/input`,async route=>{
    const payload=route.request().postDataJSON() as {input:string;client_id:string};
    submitted=payload;
    appendFileSync(log,JSON.stringify({
      type:'event_msg',timestamp:new Date().toISOString(),payload:{
        type:'item_completed',turn_id:'quote-turn',item:{
          type:'UserMessage',id:'quoted-reply',client_id:payload.client_id,content:[{type:'text',text:payload.input}],
        },
      },
    })+'\n');
    await route.fulfill({status:202,json:{status:'submitted'}});
  });
  try {
    await page.goto('/');
    const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
    const answer=chat.locator('article[data-phase="final"]').filter({hasText:original});
    const editor=chat.getByRole('textbox',{name:'发送给当前 Agent 的消息'});
    const preview=chat.getByRole('group',{name:'待发送引用'});
    await editor.fill('请展开第一点。');
    await answer.getByRole('button',{name:'引用这条消息'}).click();
    await expect(preview).toContainText(original);
    await expect(editor).toHaveText('请展开第一点。');
    await chat.getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(()=>submitted?.input).toContain(original);
    await expect(preview).toHaveCount(0);

    await page.reload();
    await page.setViewportSize({width:390,height:844});
    const reply=chat.locator('article.user').filter({hasText:'请展开第一点。'});
    const quote=reply.getByRole('button',{name:/跳到引用原消息/});
    await expect(reply).toHaveCount(1);
    await expect(quote).toBeVisible();
    await expect(quote).toContainText(original);
    await expect(reply).not.toContainText('agentmanager_quote');
    expect(await reply.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBeTruthy();
    await quote.click();
    await expect(answer).toHaveAttribute('data-notification-focus','true');
  } finally {
    await page.request.delete(`/api/sessions/${session.id}`);
    await page.request.delete(`/api/projects/${project.id}`);
  }
});
