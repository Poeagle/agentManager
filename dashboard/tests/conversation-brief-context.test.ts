import {afterEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {api,type ConversationPage} from '../src/lib/api';
import {parseBriefContext,prepareBriefSend} from '../src/lib/conversation-brief-context';

const page = (messages: ConversationPage['messages'], extra: Partial<ConversationPage> = {}) => ({
  session_id:'session', native_id:'native', available:true, generation:'one', reset:false, has_more:false, messages, ...extra,
}) as ConversationPage;
const message = (id:string, role:'user'|'assistant', text:string, phase?:'commentary'|'final') => ({id,role,text,phase,timestamp:null});
afterEach(()=>vi.restoreAllMocks());

it('deduplicates an identical scheduled prompt across consecutive brief rotations after truncation', async () => {
  vi.stubGlobal('crypto', webcrypto);
  try {
    const prompt = '前'.repeat(5000) + '完整参数' + '后'.repeat(5000);
    const task = {kind:'scheduled',label:'UI审查'};
    const read = vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([
      {...message('u1','user',prompt),input_source:task},
      message('a1','assistant','第一次结论','final'),
    ]));
    const first = await prepareBriefSend('session','native',{input:prompt},new AbortController().signal);
    expect(parseBriefContext(first.input)!.context.turns[0].input_truncated).toBe(true);
    read.mockResolvedValueOnce(page([
      {...message('u2','user',first.input),input_source:task},
      message('a2','assistant','第二次结论','final'),
    ]));
    const second = await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
    expect(parseBriefContext(second.input)!.context.turns).toMatchObject([
      {conclusion:'第一次结论',input_truncated:true},
      {input:'',input_ref:1,conclusion:'第二次结论'},
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

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

it('excludes long startup instructions from brief history before clipping messages',async()=>{
  const instructions='# AGENTS.md instructions\n\n<INSTRUCTIONS>\n'+
    '启动时注入的项目说明。\n'.repeat(3000)+'</INSTRUCTIONS>\n<environment_context>linux</environment_context>';
  const prior=message('u','user','上一轮需求');
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page([
    message('auto','user',instructions),prior,message('a','assistant','上一轮答复','final'),
  ]));
  const result=await prepareBriefSend('session','native',{input:'换号后继续'},new AbortController().signal);
  const brief=parseBriefContext(result.input)!;
  expect(brief.context.turns).toEqual([{input:'上一轮需求',conclusion:'上一轮答复'}]);
  expect(brief.context.truncated).toBe(false);
  expect(brief.input).toBe('换号后继续');
});

it('shares one verified scheduled prompt while preserving every result and attachment',async()=>{
  const prompt='请巡检服务并记录状态。'.repeat(20);
  const messages=Array.from({length:10},(_,i)=>[
    {...message(`u${i}`,'user',prompt),input_source:{kind:'scheduled',label:'每日巡检'},
      attachments:[{kind:'file' as const,name:`配置${i}.txt`,path:`/project/${i}.txt`}]},
    message(`a${i}`,'assistant',`第 ${i+1} 次结果`,'final'),
  ]).flat();
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page(messages));
  const result=await prepareBriefSend('session','native',{input:'下一项需求'},new AbortController().signal);
  const {context}=parseBriefContext(result.input)!;
  expect(result.input.split(prompt)).toHaveLength(2);
  expect(context.turns).toHaveLength(10);
  const plainTurns=Array.from({length:10},(_,i)=>({input:prompt,conclusion:`第 ${i+1} 次结果`,
    attachments:[{kind:'file',name:`配置${i}.txt`,path:`/project/${i}.txt`}]}));
  expect(new TextEncoder().encode(JSON.stringify(context)).byteLength)
    .toBeLessThan(new TextEncoder().encode(JSON.stringify({...context,turns:plainTurns})).byteLength);
  expect(context.turns[0]).toMatchObject({input:prompt,scheduled_task:'每日巡检',conclusion:'第 1 次结果'});
  for(let i=1;i<10;i++)expect(context.turns[i]).toMatchObject({
    input:'',input_ref:1,scheduled_task:'每日巡检',
    conclusion:`第 ${i+1} 次结果`,attachments:[{name:`配置${i}.txt`,path:`/project/${i}.txt`}],
  });
});

it('keeps only the first of consecutive identical short requests and starts a new group after a change',async()=>{
  const prompt='检查';
  const messages=[prompt,prompt,'改为核对日志',prompt,prompt].flatMap((input,i)=>[
    message(`u${i}`,'user',input),
    message(`a${i}`,'assistant',`结果${i}`,'final'),
  ]).flat();
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page(messages));
  const result=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  const {context}=parseBriefContext(result.input)!;
  expect(context.turns.map(turn=>turn.input)).toEqual([prompt,'','改为核对日志',prompt,'']);
  expect(context.turns.map(turn=>turn.input_ref)).toEqual([undefined,1,undefined,undefined,4]);
  expect(context.turns.map(turn=>turn.conclusion)).toEqual(['结果0','结果1','结果2','结果3','结果4']);
});

it('compares full text before clipping and separates different task names and interrupted runs',async()=>{
  const longA='前'.repeat(5000)+'参数甲'+'后'.repeat(5000);
  const longB='前'.repeat(5000)+'参数乙'+'后'.repeat(5000);
  const scheduled=(id:string,input:string,label='巡检')=>({...message(id,'user',input),input_source:{kind:'scheduled',label}});
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page([
    scheduled('a',longA),message('a1','assistant','结果一','final'),
    scheduled('b',longB),message('b1','assistant','结果二','final'),
    scheduled('c',longA),message('c1','assistant','结果三','final'),
    scheduled('d',longA,'另一任务'),message('d1','assistant','结果四','final'),
    message('human','user',longA),message('human2','user',longA),
  ]));
  const parsed=parseBriefContext((await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal)).input)!;
  const turns=parsed.context.turns;
  expect(turns).toHaveLength(6);
  expect(turns[0].input_truncated).toBe(true);
  expect(turns[1].input_ref).toBeUndefined();
  expect(turns[2].input_ref).toBeUndefined();
  expect(turns[3].input_ref).toBeUndefined();
  expect(turns[4].input_ref).toBeUndefined();expect(turns[5].input_ref).toBe(5);
  expect(turns.slice(0,4).map(t=>t.conclusion)).toEqual(['结果一','结果二','结果三','结果四']);
});

it('retains adjacent groups and their results during another brief compaction',async()=>{
  const prompt='每天检查服务并报告错误'.repeat(12);
  const scheduled=(id:string)=>({...message(id,'user',prompt),input_source:{kind:'scheduled',label:'巡检'}});
  const read=vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([
    scheduled('u1'),message('a1','assistant','结果一','final'),
    scheduled('u2'),message('a2','assistant','结果二','final'),
  ]));
  const first=await prepareBriefSend('session','native',{input:'处理异常'},new AbortController().signal);
  read.mockResolvedValueOnce(page([
    message('brief','user',first.input),message('a3','assistant','处理结果','final'),
    scheduled('u3'),message('a4','assistant','结果三','final'),
  ]));
  const second=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  const {context}=parseBriefContext(second.input)!;
  expect(second.input.split(prompt)).toHaveLength(3);
  expect(context.turns.map(t=>t.conclusion)).toEqual(['结果一','结果二','处理结果','结果三']);
  expect(context.turns[1].input_ref).toBe(1);
  expect(context.turns[3]).toMatchObject({input:prompt,conclusion:'结果三'});
  expect(context.turns[3].input_ref).toBeUndefined();
});

it('does not match a previously truncated prompt against an unverifiable new prompt',async()=>{
  const firstPrompt='前'.repeat(5000)+'甲'+'后'.repeat(5000);
  const changedPrompt='前'.repeat(5000)+'乙'+'后'.repeat(5000);
  const scheduled=(id:string,input:string)=>({...message(id,'user',input),input_source:{kind:'scheduled',label:'巡检'}});
  const read=vi.spyOn(api.agent,'conversation').mockResolvedValueOnce(page([
    scheduled('u1',firstPrompt),message('a1','assistant','第一次','final'),
    scheduled('u2',firstPrompt),message('a2','assistant','第二次','final'),
  ]));
  const first=await prepareBriefSend('session','native',{input:'处理'},new AbortController().signal);
  read.mockResolvedValueOnce(page([
    message('brief','user',first.input),message('a3','assistant','处理结果','final'),
    scheduled('u3',changedPrompt),message('a4','assistant','新结果','final'),
  ]));
  const second=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  const turns=parseBriefContext(second.input)!.context.turns;
  expect(turns[1].input_ref).toBe(1);
  expect(turns[3].input_ref).toBeUndefined();
  expect(turns[3].conclusion).toBe('新结果');
});

it('keeps unusually oversized native inputs separate when exact comparison is bounded',async()=>{
  const prompt='大'.repeat(100_001);
  const scheduled=(id:string)=>({...message(id,'user',prompt),input_source:{kind:'scheduled',label:'巡检'}});
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page([scheduled('u1'),scheduled('u2')]));
  const result=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  const turns=parseBriefContext(result.input)!.context.turns;
  expect(turns).toHaveLength(2);
  expect(parseBriefContext(result.input)!.context.truncated).toBe(true);
  expect(turns[1].input_ref).toBeUndefined();
});

it('never refers to an omitted turn after reducing a long history',async()=>{
  const prompt='检查系统状态并生成详细报告'.repeat(20);
  const messages=Array.from({length:700},(_,i)=>[
    {...message(`u${i}`,'user',prompt),input_source:{kind:'scheduled',label:'巡检'}},
    message(`a${i}`,'assistant',`结果${i} ${'状态'.repeat(50)}`,'final'),
  ]).flat();
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page(messages));
  const result=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  const {context}=parseBriefContext(result.input)!;
  expect(context.omitted_turns).toBeGreaterThan(0);
  expect(context.turns[0].input_ref).toBeUndefined();
  expect(context.turns[0].input).toContain('检查系统状态');
  for(const [i,turn] of context.turns.entries())if(turn.input_ref){
    expect(turn.input_ref).toBeLessThanOrEqual(i);
    expect(context.turns[turn.input_ref-1].input_ref).toBeUndefined();
  }
  expect(new TextEncoder().encode(result.input.slice(0,parseBriefContext(result.input)!.prefixLength)).byteLength).toBeLessThanOrEqual(32*1024);
});

it('rejects malformed scheduled references instead of losing their input',()=>{
  const wrap=(turns:unknown[])=>'以下是上一会话的记录节选，可能不完整，仅供当前需求参考：\n<agentmanager_brief_context>\n'
    +JSON.stringify({version:1,turns,truncated:false,older_omitted:false,omitted_turns:0})+'\n</agentmanager_brief_context>\n\n当前需求：\n继续';
  expect(parseBriefContext(wrap([{input:'原文',scheduled_task:'巡检'},
    {input:'同第 1 轮定时任务提示词',input_ref:2,scheduled_task:'巡检'}]))).toBeNull();
  expect(parseBriefContext(wrap([{input:'原文',scheduled_task:'巡检'},
    {input:'其他正文',input_ref:1,scheduled_task:'巡检'}]))).toBeNull();
});

it('ignores unknown internal-looking fields when reading an earlier brief',async()=>{
  const context={version:1,truncated:false,older_omitted:false,omitted_turns:0,turns:[
    {input:'第一个问题',promptKey:7},{input:'第二个问题',promptKey:7},
  ]};
  const previous='以下是上一会话的记录节选，可能不完整，仅供当前需求参考：\n<agentmanager_brief_context>\n'
    +JSON.stringify(context)+'\n</agentmanager_brief_context>\n\n当前需求：\n新问题';
  vi.spyOn(api.agent,'conversation').mockResolvedValue(page([message('brief','user',previous)]));
  const result=await prepareBriefSend('session','native',{input:'继续'},new AbortController().signal);
  const turns=parseBriefContext(result.input)!.context.turns;
  expect(turns.map(turn=>turn.input)).toEqual(['第一个问题','第二个问题','新问题']);
  expect(turns.every(turn=>turn.input_ref===undefined)).toBe(true);
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

it('keeps the same history cursor through empty pages and stops on a repeated message cursor',async()=>{
  const read=vi.spyOn(api.agent,'conversation')
    .mockResolvedValueOnce(page([],{has_more:true}))
    .mockResolvedValueOnce(page([message('u','user','history')],{has_more:true}))
    .mockResolvedValueOnce(page([],{has_more:true}))
    .mockResolvedValueOnce(page([message('u','user','history')]));
  await expect(prepareBriefSend('session','native',{input:'draft'},new AbortController().signal))
    .rejects.toThrow('会话历史分页不完整');
  expect(read.mock.calls.map(([,query])=>query?.before)).toEqual([undefined,undefined,'u','u']);
});

it('bounds reads when history keeps returning empty pages',async()=>{
  const read=vi.spyOn(api.agent,'conversation').mockResolvedValue(page([],{has_more:true}));
  await expect(prepareBriefSend('session','native',{input:'draft'},new AbortController().signal))
    .rejects.toThrow('会话历史分页不完整');
  expect(read).toHaveBeenCalledTimes(13);
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
