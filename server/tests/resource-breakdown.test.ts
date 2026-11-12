import Fastify from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {parseDirectoryUsage,parseProcessList,parseProcessTicks,readDirectoryBreakdown} from '../src/services/resource-breakdown.js';
import {createTestDatabase} from './helpers/database.js';
import {authHook,createSession,createUser} from '../src/auth.js';
import {userRoutes} from '../src/routes/users.js';
import {serverResourceSampler} from '../src/services/server-resources.js';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

it('parses bounded process and directory fields without exposing arguments',()=>{
 expect(parseProcessList(' 42 alice 1024 12.5 node\n 43 bob 8 0.0 process name\ninvalid')).toEqual([
  {pid:42,user:'alice',memory_bytes:1048576,cpu_percent:12.5,program:'node'},
  {pid:43,user:'bob',memory_bytes:8192,cpu_percent:0,program:'process name'},
 ]);
 const fields=['S',...Array(10).fill('0'),'25','15',...Array(6).fill('0'),'123', '0','7'];
 expect(parseProcessTicks(`42 (name with ) parens) ${fields.join(' ')}`)).toEqual({ticks:40,start:'123'});
 expect(parseDirectoryUsage('10\t/home\n5\t/var\n100\t/\n','/')).toEqual([{path:'/home',bytes:10240},{path:'/var',bytes:5120}]);
});
let cleanup:(()=>void)|undefined;
afterEach(()=>{cleanup?.();vi.restoreAllMocks();});
it('requires monitor permission and validates the resource kind and path',async()=>{
 ({cleanup}=createTestDatabase());const admin=createUser({username:'breakdown-admin',password:'password1',role:'admin'}),member=createUser({username:'breakdown-member',password:'password1'});
 const app=Fastify();app.addHook('onRequest',authHook);await app.register(userRoutes,{prefix:'/api'});
 try{
  const memberCookie=`agentmanager_session=${createSession(member.id)}`,adminCookie=`agentmanager_session=${createSession(admin.id)}`;
  expect((await app.inject({url:'/api/admin/resource-breakdown?kind=cpu',headers:{cookie:memberCookie}})).statusCode).toBe(403);
  expect((await app.inject({url:'/api/admin/resource-breakdown?kind=unknown',headers:{cookie:adminCookie}})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/admin/resource-breakdown?kind=disk&path=relative',headers:{cookie:adminCookie}})).statusCode).toBe(400);
 }finally{await app.close();}
});

it('scans only the selected filesystem directory and prevents escaping the mount',async()=>{
 const root=mkdtempSync(join(tmpdir(),'resource-test-'));
 try{
  mkdirSync(join(root,'large'));mkdirSync(join(root,'small'));
  writeFileSync(join(root,'large','file'),Buffer.alloc(16384));writeFileSync(join(root,'small','file'),Buffer.alloc(1024));
  vi.spyOn(serverResourceSampler,'read').mockResolvedValue({disk:{mount:root}} as never);
  const result=await readDirectoryBreakdown(root);
  expect(result.path).toBe(root);expect(result.rows.map(row=>row.path)).toEqual([join(root,'large'),join(root,'small')]);
  await expect(readDirectoryBreakdown('/')).rejects.toThrow('outside the server disk');
 }finally{rmSync(root,{recursive:true,force:true});}
});
