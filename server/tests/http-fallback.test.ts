import Fastify from 'fastify';
import {expect,it} from 'vitest';
import {installApiFallback} from '../src/http-fallback.js';
it('returns JSON API 404/405 before a static wildcard while preserving SPA navigation',async()=>{
 const app=Fastify(); installApiFallback(app);
 await app.register(async api=>{api.put('/files/write',async()=>({ok:true}));api.get('/sessions/:id/controls',async()=>({ok:true}));},{prefix:'/api'});
 app.get('/*',async(_req,reply)=>reply.type('text/html').send('<html>SPA</html>'));
 try {
  for(const url of ['/api','/api/missing','/api/missing?x=1']) {const res=await app.inject(url);expect(res.statusCode).toBe(404);expect(res.json().error).toBeTruthy();}
  for(const [method,url,allow] of [['POST','/api/files/write','PUT'],['POST','/api/sessions/thread/controls','GET']]) {
   const res=await app.inject({method:method as any,url});expect(res.statusCode).toBe(405);expect(res.headers.allow).toContain(allow);expect(res.json().error).toBeTruthy();
  }
  expect((await app.inject({method:'PUT',url:'/api/files/write'})).statusCode).toBe(200);
  expect((await app.inject('/projects')).body).toContain('SPA');
 }finally{await app.close();}
});
