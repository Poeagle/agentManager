import Fastify from 'fastify';
import {expect,it} from 'vitest';
import {AgentQuotaNotApplicable,sendAgentQuota} from '../src/services/agents/quota-response.js';
it('distinguishes account quota, not-applicable authentication and actual outages',async()=>{
 const app=Fastify();
 app.get('/ok',async(_,reply)=>sendAgentQuota(reply,async()=>({remainingPercent:64})));
 app.get('/api-key',async(_,reply)=>sendAgentQuota(reply,async()=>{throw new AgentQuotaNotApplicable();}));
 app.get('/outage',async(_,reply)=>sendAgentQuota(reply,async()=>{throw Error('PRIVATE REQUEST SECRET');}));
 try {
  expect((await app.inject('/ok')).json()).toEqual({quota:{remainingPercent:64}});
  const key=await app.inject('/api-key');expect(key.statusCode).toBe(200);expect(key.json()).toMatchObject({quota:null,reason:'not_applicable'});
  const fail=await app.inject('/outage');expect(fail.statusCode).toBe(503);expect(fail.json()).toMatchObject({quota:null,reason:'unavailable'});expect(fail.body).not.toContain('PRIVATE');
 }finally{await app.close();}
});
