import Fastify,{type FastifyInstance} from 'fastify';
import {mkdirSync,symlinkSync,writeFileSync} from 'fs';
import {join} from 'path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {authHook,createUser,createSession} from '../src/auth.js';
import {getDb} from '../src/db/index.js';
import {fileRoutes} from '../src/routes/files.js';
import {saveSharedResources} from '../src/services/shared-resources/store.js';
import {createTestDatabase} from './helpers/database.js';
let app:FastifyInstance,cleanup:()=>void,root:string,outside:string,cookie:string,owner:string,memberCookie:string;
beforeEach(async()=>{
 const db=createTestDatabase();cleanup=db.cleanup;root=join(db.dir,'project');outside=join(db.dir,'outside');mkdirSync(root);mkdirSync(outside);
 owner=createUser({username:'owner',password:'password1',role:'admin'}).id;cookie=`agentmanager_session=${createSession(owner)}`;
 const member=createUser({username:'member',password:'password2'}).id;memberCookie=`agentmanager_session=${createSession(member)}`;
 getDb().prepare('INSERT INTO projects(id,name,path,owner_id) VALUES (?,?,?,?)').run('project','Project',root,owner);
 app=Fastify({logger:false});app.addHook('onRequest',authHook);await app.register(fileRoutes,{prefix:'/api'});
});
afterEach(async()=>{await app.close();cleanup();});
const get=(path:string,auth=cookie)=>app.inject({url:`/api/files/stat?project_id=project&path=${encodeURIComponent(path)}`,headers:{cookie:auth}});
describe('preview path metadata',()=>{
 it('recognizes dotted directories and classifies files without reading their bytes',async()=>{
  const dir=join(root,'reports.md'),file=join(root,'binary');mkdirSync(dir);writeFileSync(file,Buffer.from([0,255,1]));expect((await get(dir)).json()).toEqual({path:dir,type:'directory'});expect((await get(file)).json()).toEqual({path:file,type:'file'});
 });
 it('exposes allowed symlinks as expandable directories',async()=>{
  mkdirSync(join(root,'reports'));symlinkSync(join(root,'reports'),join(root,'linked'));expect((await get(join(root,'linked'))).json().type).toBe('directory');const listing=await app.inject({url:`/api/files?project_id=project&path=${encodeURIComponent(root)}`,headers:{cookie}});expect(listing.json().files.find((entry:any)=>entry.name==='linked').type).toBe('directory');
 });
 it('rejects traversal and external symlinks even for administrators',async()=>{
  symlinkSync(outside,join(root,'escape'));for(const path of [outside,join(root,'..','outside'),join(root,'escape')])expect((await get(path)).statusCode).toBe(403);
 });
 it('allows unscoped authorized files while rejecting unassigned paths and private resources',async()=>{
  const path=join(outside,'external.py');writeFileSync(path,'print(42)');
  const request=(route:string,target:string,auth=cookie)=>app.inject({url:`/api${route}?path=${encodeURIComponent(target)}`,headers:{cookie:auth}});
  expect((await request('/files/stat',path)).json()).toEqual({path,type:'file'});
  expect((await request('/files/read',path)).json().content).toBe('print(42)');
  expect((await request('/files/stat',path,memberCookie)).statusCode).toBe(403);expect((await request('/files/stat',path,'')).statusCode).toBe(401);
  const secret=join(outside,'.env');writeFileSync(secret,'secret');saveSharedResources(owner,{directory:outside,scope_path:outside,env_file:secret,instructions:'',enabled:true,revision:0});expect((await request('/files/stat',secret)).statusCode).toBe(403);
 });
 it('accepts an authorized project path through a filesystem alias without widening scoped reads',async()=>{
  const file=join(root,'inside.py'),alias=join(outside,'project-alias');writeFileSync(file,'ok');symlinkSync(root,alias);
  const member=createUser({username:'project-member',password:'password2'}).id;getDb().prepare('UPDATE projects SET owner_id=? WHERE id=?').run(member,'project');
  const auth=`agentmanager_session=${createSession(member)}`,target=join(alias,'inside.py');
  const unscoped=await app.inject({url:`/api/files/stat?path=${encodeURIComponent(target)}`,headers:{cookie:auth}});expect(unscoped.statusCode).toBe(200);expect(unscoped.json().type).toBe('file');
  expect((await get(target,auth)).statusCode).toBe(403);
 });
 it('protects credential paths from metadata access',async()=>{
  const path=join(root,'.env');writeFileSync(path,'PRIVATE_SECRET=must-not-leak');saveSharedResources(owner,{directory:root,scope_path:root,env_file:path,instructions:'instructions',enabled:true,revision:0});const response=await get(path);expect(response.statusCode).toBe(403);expect(response.body).not.toContain('must-not-leak');
 });
 it('requires project access and authentication',async()=>{expect((await get(root,memberCookie)).statusCode).toBe(403);expect((await get(root,'')).statusCode).toBe(401);});
 it('reports missing paths',async()=>{expect((await get(join(root,'gone'))).statusCode).toBe(404);expect((await get('')).statusCode).toBe(400);});
});
