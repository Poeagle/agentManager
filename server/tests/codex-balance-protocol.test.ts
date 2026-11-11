import {describe,it,expect,vi} from 'vitest';
import {balanceProtocol,parseWallet,readWallet} from '../src/services/agents/codex/balance-protocol.js';

describe('wallet provider protocols',()=>{
 it('requires an explicitly registered origin',()=>{
  expect(balanceProtocol('https://sub.wanzhao.top/v1')).toBe('sub2api');
  expect(balanceProtocol('https://xindu.xyz/v1')).toBe('sub2api');
  expect(balanceProtocol('https://api.deepseek.com/v1')).toBe('deepseek');
  expect(balanceProtocol('https://example.com/v1')).toBeNull();
 });
 it('reads actual wallet and provider costs without fabricating missing values',()=>{
  expect(parseWallet('sub2api',{balance:66.81,unit:'USD',mode:'unrestricted',usage:{today:{actual_cost:1.2,requests:3},total:{actual_cost:5}}})).toEqual({status:'available',amount:66.81,currency:'USD',mode:'unrestricted',todayActualCost:1.2,todayRequests:3,totalActualCost:5});
  expect(parseWallet('sub2api',{quota:{remaining:14}})).toMatchObject({status:'available',amount:14,currency:'USD',todayActualCost:null});
  expect(parseWallet('deepseek',{balance_infos:[{currency:'CNY',total_balance:'81.61'}]})).toMatchObject({status:'available',amount:81.61,currency:'CNY'});
  expect(parseWallet('sub2api',{})).toEqual({status:'unavailable',error:'invalid_response'});
 });
 it('sends credentials only to the registered origin and distinguishes failures',async()=>{
  const request=vi.fn(async()=>new Response('{"remaining":2}',{status:200}));
  expect(await readWallet('https://xindu.xyz/v1','test-key',{fetch:request as typeof fetch})).toMatchObject({status:'available',amount:2});
  expect(String(request.mock.calls[0][0])).toBe('https://xindu.xyz/v1/usage');
  expect((request.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  expect(await readWallet('https://xindu.xyz/v1','')).toMatchObject({error:'missing_key'});
  for(const [status,error] of [[401,'unauthorized'],[403,'unauthorized'],[404,'unsupported']] as const){
   expect(await readWallet('https://xindu.xyz','key',{fetch:(async()=>new Response('',{status})) as typeof fetch})).toMatchObject({error});
  }
  expect(await readWallet('https://xindu.xyz','key',{fetch:(async()=>new Response('bad')) as typeof fetch})).toMatchObject({error:'invalid_response'});
  expect(await readWallet('https://xindu.xyz','key',{fetch:(async()=>new Response('123456')) as typeof fetch,maxBytes:4})).toMatchObject({error:'too_large'});
  expect(await readWallet('https://xindu.xyz','key',{timeoutMs:1,fetch:((_url:unknown,init:RequestInit)=>new Promise((_resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(Error('aborted'))))) as typeof fetch})).toMatchObject({error:'timeout'});
 });
});
