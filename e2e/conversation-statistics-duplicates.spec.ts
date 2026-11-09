import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('deduplicates native conclusion echoes and shows actual usage and duration after reload',async({page})=>{
 const auth=await(await page.request.get('/api/auth/status')).json();
 expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
 const root=join(process.cwd(),'.test-data/e2e'),projectPath=join(root,'statistics-project');mkdirSync(projectPath,{recursive:true});
 const {project}=await(await page.request.post('/api/projects',{data:{name:'Statistics fixture',path:projectPath}})).json();
 const {session}=await(await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:projectPath,mode:'terminal'}})).json();
 const native='019ff001-bbbb-7bbb-8bbb-bbbbbbbbbbbb',dir=join(root,'home/.codex/sessions');mkdirSync(dir,{recursive:true});
 const line=(timestamp:string,type:string,payload:unknown)=>JSON.stringify({timestamp,type,payload})+'\n';
 const content=[{type:'output_text',text:'测试结论'}];
 const usage={total_token_usage:{total_tokens:200},last_token_usage:{total_tokens:200,input_tokens:180,cached_input_tokens:50,output_tokens:20,reasoning_output_tokens:5}};
 writeFileSync(join(dir,`rollout-statistics-${native}.jsonl`),
  line('2026-10-29T10:00:00Z','event_msg',{type:'task_started',turn_id:'turn'})+
  line('2026-10-29T10:00:01Z','response_item',{type:'message',id:'user',role:'user',content:[{type:'input_text',text:'测试问题'}]})+
  line('2026-10-29T10:00:20Z','response_item',{type:'custom_tool_call',call_id:'tool'})+
  line('2026-10-29T10:01:04Z','event_msg',{type:'item_completed',turn_id:'turn',item:{type:'AgentMessage',id:'answer',phase:'final_answer',content}})+
  line('2026-10-29T10:01:04.001Z','response_item',{type:'message',id:'answer',role:'assistant',phase:'final_answer',content})+
  line('2026-10-29T10:01:05Z','event_msg',{type:'token_count',info:usage})+
  line('2026-10-29T10:01:06Z','event_msg',{type:'task_complete',turn_id:'turn',last_agent_message:'测试结论'}));
 const require=createRequire(import.meta.url),Database=require('../server/node_modules/better-sqlite3'),db=new Database(join(root,'agentmanager.db'));
 try{db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=? WHERE id=?').run('codex',native,session.id);}finally{db.close();}
 await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
 await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
 await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{terminalInstances:[{id:session.id,label:'统计测试'}],activeTerminalId:session.id,explorerInstances:[],hiddenSessionIds:[]}}});
 await page.routeWebSocket('**/conversation/stream*',socket=>socket.send(JSON.stringify({type:'snapshot',messages:[],busy:false,stage:'idle'})));
 await page.goto('/');const chat=page.getByRole('region',{name:'会话对话'}).filter({visible:true});
 const verify=async()=>{await expect(chat.getByText('测试结论',{exact:true})).toHaveCount(1);await expect(chat.getByText('summary · token: 200 · tools: 1 call / 1 round')).toBeVisible();await expect(chat.getByText('Total: 1m 4s')).toBeVisible();};
 await verify();await page.reload();await verify();
 await page.request.delete(`/api/sessions/${session.id}`);
});
