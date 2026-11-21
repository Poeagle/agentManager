import {afterEach,expect,it,vi} from 'vitest';
import {api,type ConversationPage} from '../src/lib/api';
import {parseBriefContext,prepareBriefSend} from '../src/lib/conversation-brief-context';

const page = (messages: ConversationPage['messages'], extra: Partial<ConversationPage> = {}) => ({
  session_id:'session', native_id:'native', available:true, generation:'one', reset:false, has_more:false, messages, ...extra,
}) as ConversationPage;
const message = (id:string, role:'user'|'assistant', text:string, phase?:'commentary'|'final') => ({id,role,text,phase,timestamp:null});
afterEach(()=>vi.restoreAllMocks());

it('collects every available input and conclusion, one visible progress item, and attachment references',async()=>{
  const read=vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([
    message('u2','user','第二个需求'),message('p2','assistant','正在处理','commentary'),
    {...message('a2','assistant','第二个结论','final'),content_blocks:[{type:'tool_use',id:'tool',index:0,name:'shell',input:'tool-result-marker',status:'completed'}]},
  ],{has_more:true})).mockResolvedValueOnce(page([
    message('auto','user','<environment_context>linux</environment_context>'),
    {...message('u1','user','第一个需求'),attachments:[{kind:'file',name:'记录.txt',path:'/project/记录.txt'}]},
    message('p1','assistant','第一轮过程','commentary'),message('a1','assistant','第一个结论','final'),
  ]));
  const result=await prepareBriefSend('session','native',{input:'继续处理',attachments:[{kind:'image',name:'new.png',path:'/project/new.png',offset:2}],batch:[{length:4,attachments:1}]},new AbortController().signal);
  const parsed=parseBriefContext(result.input)!;
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1][1]).toEqual({limit:'80',before:'u2'});
  expect(parsed.input).toBe('继续处理');
  expect(parsed.context.turns).toEqual([
    {input:'第一个需求',progress:'第一轮过程',conclusion:'第一个结论',attachments:[{kind:'file',name:'记录.txt',path:'/project/记录.txt'}]},
    {input:'第二个需求',progress:'正在处理',conclusion:'第二个结论'},
  ]);
  expect(parsed.context.truncated).toBe(false);
  expect(result.input).not.toContain('tool-result-marker');
  expect(result.attachments?.[0].offset).toBe(parsed.prefixLength+2);
  expect(result.batch?.[0].length).toBe(parsed.prefixLength+4);
});

it('keeps existing brief history on repeated compaction without nesting its wrapper',async()=>{
  vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([message('u','user','原始需求'),message('a','assistant','原始结论','final')]));
  const first=await prepareBriefSend('session','native',{input:'后续需求'},new AbortController().signal);
  vi.mocked(api.agent.conversation).mockResolvedValueOnce(page([message('u2','user',first.input),message('a2','assistant','后续结论','final')]));
  const second=await prepareBriefSend('session','native',{input:'再继续'},new AbortController().signal);
  const parsed=parseBriefContext(second.input)!;
  expect(parsed.context.turns.map(t=>t.input)).toEqual(['原始需求','后续需求']);
  expect(parsed.context.turns[1].conclusion).toBe('后续结论');
  expect(parsed.input).toBe('再继续');
});

it('does not invent a final conclusion when the agent did not identify one',async()=>{
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page([message('u','user','需求'),message('a','assistant','尚未确认阶段')]));
  const result=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  expect(parseBriefContext(result.input)?.context.turns).toEqual([{input:'需求',progress:'尚未确认阶段'}]);
});

it('bounds multibyte history and marks truncation without cutting the current input',async()=>{
  const turns=Array.from({length:80},(_,i)=>[message(`u${i}`,'user',`需求${i} ${'中文字🙂'.repeat(200)}`),message(`a${i}`,'assistant',`结论${i} ${'内容🙂'.repeat(200)}`,'final')]).flat();
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page(turns));
  const draft='现在的需求🙂';
  const result=await prepareBriefSend('session','native',{input:draft},new AbortController().signal);
  const parsed=parseBriefContext(result.input)!;
  expect(parsed.input).toBe(draft);
  expect(parsed.context.truncated||parsed.context.omitted_turns>0).toBe(true);
  expect(new TextEncoder().encode(result.input).byteLength).toBeLessThanOrEqual(64*1024);
  expect(new TextEncoder().encode(result.input.slice(0,parsed.prefixLength)).byteLength).toBeLessThanOrEqual(32*1024);
  expect(result.input).not.toContain('\ufffd');
});

it('retains the newest turns when even short excerpts cannot fit',async()=>{
  const turns=Array.from({length:900},(_,i)=>[message(`u${i}`,'user',`需求${i} ${'x'.repeat(100)}`),message(`a${i}`,'assistant',`结论${i} ${'y'.repeat(100)}`,'final')]).flat();
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page(turns));
  const result=await prepareBriefSend('session','native',{input:'当前需求'},new AbortController().signal);
  const parsed=parseBriefContext(result.input)!;
  expect(parsed.context.omitted_turns).toBeGreaterThan(0);
  expect(parsed.context.turns.at(-1)?.input).toContain('需求899');
  expect(parsed.input).toBe('当前需求');
});

it('rejects a replaced or changing history before starting a new conversation',async()=>{
  const read=vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([message('u','user','history')],{native_id:'other'}));
  await expect(prepareBriefSend('session','native',{input:'draft'},new AbortController().signal)).rejects.toThrow('无法读取原会话历史');
  read.mockResolvedValueOnce(page([message('u2','user','new')],{has_more:true})).mockResolvedValueOnce(page([message('u1','user','old')],{generation:'replaced'}));
  await expect(prepareBriefSend('session','native',{input:'draft'},new AbortController().signal)).rejects.toThrow('历史已变化');
});

it('rejects unavailable history and an oversized current draft',async()=>{
  const read=vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([],{available:false}));
  await expect(prepareBriefSend('session','native',{input:'draft'},new AbortController().signal)).rejects.toThrow('无法读取原会话历史');
  read.mockResolvedValueOnce(page([message('u','user','history')]));
  await expect(prepareBriefSend('session','native',{input:'x'.repeat(65500)},new AbortController().signal)).rejects.toThrow('草稿过长');
});
