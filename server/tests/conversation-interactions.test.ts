import {describe,expect,it} from 'vitest';
import {nativeInteraction,nativeInteractionAnswer,conversationAsyncQuestions} from '../src/services/conversation-interactions.js';
const request=(method:string,params:any)=>({id:'request',method,params:{threadId:'thread',turnId:'turn',...params}});
describe('structured human requests',()=>{
  it('recognizes actual nonblocking AgentMessage metadata without inferring questions from text',()=>{
    const questions=[{title:'想去哪里？',options:['太空','深海','森林']}];
    expect(conversationAsyncQuestions({delivery:'async',questions})).toEqual(questions);
    for(const item of [{questions},{delivery:'async',questions:[]},{delivery:'async',questions:[{title:'x',options:[42]}]},{delivery:'async',questions:[{title:'',options:null}]}])expect(conversationAsyncQuestions(item)).toBeUndefined();
  });
  it('ignores unknown tools, non-requests, other threads and malformed question sets',()=>{
    for(const frame of [request('item/tool/call',{}),{method:'item/tool/requestUserInput',params:{}},request('item/tool/requestUserInput',{questions:[]}),request('item/tool/requestUserInput',{questions:[{id:'q',question:'a'},{id:'q',question:'b'}]})])expect(nativeInteraction(frame,'thread')).toBeNull();
    expect(nativeInteraction(request('item/fileChange/requestApproval',{}),'other')).toBeNull();
  });
  it('validates all questions, custom input and secret answers without reflecting them into cards',()=>{
    const params={questions:[{id:'q',question:'范围',isOther:true,options:[{label:'试用',description:'隔离'}]},{id:'secret',question:'口令',isSecret:true,options:null}],isBlocking:false};
    const card=nativeInteraction(request('item/tool/requestUserInput',params),'thread')!;
    expect(card.blocking).toBe(false);
    const answer={answers:{q:{answers:['自定义范围']},secret:{answers:['private-value']}}};
    expect(nativeInteractionAnswer(card,params,answer)).toEqual(answer);
    expect(JSON.stringify(card)).not.toContain('private-value');
    expect(()=>nativeInteractionAnswer(card,params,{answers:{q:{answers:['试用']}}})).toThrow('全部问题');
    expect(()=>nativeInteractionAnswer(card,params,{answers:{q:{answers:['试用','正式']},secret:{answers:['abc']}}})).toThrow();
  });
  it('permits only one-shot decisions and builds grants from the native request',()=>{
    for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval']) {
      const params={permissions:{network:{enabled:true},fileSystem:null}},card=nativeInteraction(request(method,params),'thread')!;
      expect(()=>nativeInteractionAnswer(card,params,{decision:'acceptForSession'})).toThrow();
      expect(nativeInteractionAnswer(card,params,{decision:'accept',permissions:{fileSystem:{write:['/']}}})).toEqual(card.kind==='permissions'?{permissions:{network:{enabled:true}},scope:'turn'}:{decision:'accept'});
      expect(nativeInteractionAnswer(card,params,{decision:'decline'})).toEqual(card.kind==='permissions'?{permissions:{},scope:'turn'}:{decision:'decline'});
    }
  });
});
