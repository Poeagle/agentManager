/** Only native, explicitly identified human requests become interactive cards. */
export interface ConversationQuestion {
  id:string;header:string;question:string;isOther:boolean;isSecret:boolean;
  options:Array<{label:string;description:string}>|null;
}
export interface ConversationInteraction {
  id:string;turn_id:string;kind:'question'|'command'|'file'|'permissions';
  title:string;detail:string;blocking:boolean;submitted:boolean;
  questions?:ConversationQuestion[];
}
const object=(value:unknown):value is Record<string,any>=>!!value && typeof value==='object' && !Array.isArray(value);
const text=(value:unknown,max=12000)=>typeof value==='string'?value.slice(0,max):'';
export function nativeInteraction(frame:any,threadId:string):ConversationInteraction|null {
  const p=frame?.params;
  if(!object(p)||p.threadId!==threadId||typeof p.turnId!=='string'||!['number','string'].includes(typeof frame.id))return null;
  const common={id:JSON.stringify(frame.id),turn_id:p.turnId,blocking:true,submitted:false};
  if(frame.method==='item/tool/requestUserInput') {
    if(!Array.isArray(p.questions)||!p.questions.length||p.questions.length>20)return null;
    const ids=new Set<string>();const questions:ConversationQuestion[]=[];
    for(const q of p.questions) {
      if(!object(q)||typeof q.id!=='string'||!q.id||ids.has(q.id)||typeof q.question!=='string')return null;
      ids.add(q.id);
      if(q.options!==null && q.options!==undefined && (!Array.isArray(q.options)||q.options.length>30||q.options.some((o:any)=>!object(o)||typeof o.label!=='string'||o.label.length>1000)))return null;
      questions.push({id:q.id,header:text(q.header,200),question:text(q.question),isOther:q.isOther===true,isSecret:q.isSecret===true,
        options:q.options?.map((o:any)=>({label:o.label,description:text(o.description,3000)}))||null});
    }
    return {...common,kind:'question',title:'Agent 需要你的回答',detail:'',blocking:p.isBlocking!==false,questions};
  }
  if(frame.method==='item/commandExecution/requestApproval')return {...common,kind:'command',title:'确认执行命令',detail:[text(p.reason),text(p.command),p.cwd?`工作目录：${text(p.cwd,4000)}`:''].filter(Boolean).join('\n\n')};
  if(frame.method==='item/fileChange/requestApproval')return {...common,kind:'file',title:'确认修改文件',detail:[text(p.reason),p.grantRoot?`允许修改范围：${text(p.grantRoot,4000)}`:''].filter(Boolean).join('\n\n')};
  if(frame.method==='item/permissions/requestApproval' && object(p.permissions))return {...common,kind:'permissions',title:'确认申请权限',detail:[text(p.reason),text(JSON.stringify(p.permissions,null,2))].filter(Boolean).join('\n\n')};
  return null;
}

/** Construct a response from the request we actually received; never relay a
 * browser-supplied protocol frame, permission profile, or persistent grant. */
export function nativeInteractionAnswer(request:ConversationInteraction,params:any,value:unknown):unknown {
  if(!object(value))throw new Error('回答格式无效');
  if(request.kind!=='question') {
    if(!['accept','decline','cancel'].includes(value.decision))throw new Error('请选择允许本次、拒绝或取消');
    if(request.kind==='permissions')return {permissions:value.decision==='accept'?Object.fromEntries(Object.entries(params.permissions).filter(([,v])=>v!==null)):{},scope:'turn'};
    return {decision:value.decision};
  }
  if(!object(value.answers)||Object.keys(value.answers).length!==request.questions!.length)throw new Error('请回答全部问题');
  const answers:Record<string,{answers:string[]}>=Object.create(null);
  for(const question of request.questions!) {
    const answer=value.answers[question.id];
    if(!object(answer)||!Array.isArray(answer.answers)||answer.answers.length!==1||typeof answer.answers[0]!=='string'||!answer.answers[0].trim()||Buffer.byteLength(answer.answers[0])>16000)throw new Error('请回答全部问题，每条回答不超过 16 KB');
    const selected=answer.answers[0];
    if(question.options?.length && !question.isOther && !question.options.some(option=>option.label===selected))throw new Error('请选择提供的选项');
    answers[question.id]={answers:[selected]};
  }
  return {answers};
}
