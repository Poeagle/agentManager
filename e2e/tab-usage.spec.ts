import {expect,test} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

test('shows lifetime usage with children after tab changes and reload',async({page})=>{
  const root=join(process.cwd(),'.test-data/e2e'),path=join(root,'tab-usage-project');
  mkdirSync(path,{recursive:true});
  const auth=await(await page.request.get('/api/auth/status')).json();
  expect((await page.request.post(auth.needsSetup?'/api/auth/setup':'/api/auth/login',{
    data:{username:'e2e-admin',password:'test-password'},
  })).ok()).toBeTruthy();
  const {project}=await(await page.request.post('/api/projects',{data:{name:'专项用量',path}})).json();
  const create=async()=>{
    const response=await page.request.post('/api/sessions',{data:{project_id:project.id,project_path:path,mode:'terminal'}});
    expect(response.ok()).toBeTruthy();
    return (await response.json()).session.id as string;
  };
  const parent=await create(),child=await create(),independent=await create();
  const nativeParent='019ff001-aaab-7aab-8aab-aaaaaaaaaaaa',nativeChild='019ff001-aaac-7aac-8aac-aaaaaaaaaaaa';
  const now='2026-11-26T06:00:00Z';
  const Database=createRequire(import.meta.url)('../server/node_modules/better-sqlite3');
  const db=new Database(join(root,'agentmanager.db'));
  try {
    const bind=db.prepare('UPDATE sessions SET cli_type=?,codex_session_id=?,parent_session_id=? WHERE id=?');
    const totals=db.prepare(`INSERT OR REPLACE INTO session_statistics_sources VALUES(?,?,?,'native',100,'fixture',0,0,'','','',0,1,1,'null','{}',?)`);
    for(const [id,native,ancestor,tokens,amount] of [
      [parent,nativeParent,null,4000000,22.5],
      [child,nativeChild,parent,2000000,12.5],
    ] as const){
      bind.run('codex',native,ancestor,id);
      const key=createHash('sha256').update(JSON.stringify(['codex','native',native])).digest('hex').slice(0,32);
      totals.run(key,'codex',native,JSON.stringify({native_id:native,status:'complete',reasons:[],revision:1,observed_at:now,
        totals:{tokens:{total_tokens:tokens},requests:1,tool_calls:0,tool_rounds:0,cost:{amount,unit:'credits',complete:true}}}));
    }
  } finally {db.close();}
  expect(await(await page.request.get(`/api/sessions/${independent}/tab-usage`)).json()).toEqual({usage:null});
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});
  await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  await page.request.put(`/api/user-state/${encodeURIComponent(`project:${project.id}`)}`,{data:{value:{
    terminalInstances:[{id:parent,label:'专项父标签'},{id:child,label:'专项子标签'},{id:independent,label:'独立标签'}],
    activeTerminalId:parent,explorerInstances:[],hiddenSessionIds:[],
  }}});
  await page.goto('/');
  const total=page.getByLabel('标签页累计用量').filter({visible:true});
  await expect(total).toHaveText('标签页累计 1.40 USD 等值');
  await expect(total).toHaveAttribute('title',/6,000,000 tokens/);
  await page.reload();
  await expect(total).toHaveText('标签页累计 1.40 USD 等值');
  await page.setViewportSize({width:390,height:844});
  await expect(total).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
