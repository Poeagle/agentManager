import {MAX_AUTOMATIC_SEND_RULES, MAX_REMINDER_SEND_RULES, MAX_SEND_GUARD_PROVIDERS, SEND_GUARD_ACTION_LABELS, type LegacySendGuardPolicy, type SendGuardRule, type SendGuardCondition, type SendGuardGroup, type SendGuardPolicy} from '../shared/send-guard.js';

export const SEND_GUARD_KEY='conversation_send_guard';
const afterIdle = (minutes: number, percent: number): SendGuardGroup => ({
 operator: 'and',
 conditions: [
  {type:'idle_minutes',value:minutes},
  {type:'context_percent',value:percent},
 ],
});
export const DEFAULT_SEND_GUARD: LegacySendGuardPolicy = {
 enabled: true,
 conditions: {
  operator: 'or',
  conditions: [
   {type:'context_percent',value:80},
   afterIdle(30,30),
   afterIdle(20,50),
   afterIdle(10,60),
   afterIdle(60,20),
  ],
 },
};
export function validateSendGuard(value:unknown):asserts value is LegacySendGuardPolicy | SendGuardPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('发送保护配置无效');
 const policy=value as LegacySendGuardPolicy | SendGuardPolicy;
 const fields='rules' in policy?['rules']:['conditions','automatic_rules'];
 if(Object.keys(value).some(k=>!['enabled','reminder_enabled',...fields].includes(k)))throw Error('不支持的发送保护字段');
 if(typeof policy.enabled!=='boolean')throw Error('请设置发送保护开关');
 if(policy.reminder_enabled!==undefined&&typeof policy.reminder_enabled!=='boolean')throw Error('请设置发送提醒开关');
 let count=0;
 function group(raw:unknown,depth:number){
  const g=raw as SendGuardGroup;
  if(!g||typeof g!=='object'||Array.isArray(g)||!['and','or'].includes(g.operator)||!Array.isArray(g.conditions))throw Error('条件组请选择且／或');
  if(Object.keys(g).some(k=>!['operator','conditions'].includes(k)))throw Error('不支持的条件组字段');
  if(depth>4||g.conditions.length>20||!g.conditions.length)throw Error('条件组须有 1–20 项，最多 4 层');
  for(const item of g.conditions){if(++count>50)throw Error('条件最多 50 项（含分组）');if(!item||typeof item!=='object')throw Error('条件无效');if('conditions' in item||'operator' in item){group(item,depth+1);continue;}
   if(Object.keys(item).some(k=>!['type','value'].includes(k)))throw Error('不支持的条件字段');
   const c=item as SendGuardCondition;
   const quota=c.type==='account_remaining_percent',min=quota?0:1;
   const max=quota?99:c.type==='context_percent'?100:c.type==='idle_minutes'?10080:c.type==='context_tokens'?2000000:0;
   if(!max||!Number.isInteger(c.value)||c.value<min||c.value>max)throw Error(`条件数值须为 ${min}–${max||100} 的整数`);
  }
 }
 function validateRule(rule:SendGuardRule,scoped:boolean){
  const fields=scoped?['action','conditions','target','provider_ids']:['action','conditions','target'];
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(k=>!fields.includes(k))
   ||typeof rule.action!=='string'||!(scoped&&rule.action==='remind'||Object.hasOwn(SEND_GUARD_ACTION_LABELS,rule.action)))
    throw Error('请选择支持的发送保护操作');
  // Accept the former opt-in for older saved policies and clients.
  if(rule.target!==undefined&&(rule.target!=='available_account'||!['new','brief'].includes(rule.action)))throw Error('旧版换号字段无效');
  const ids=rule.provider_ids;
  if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>MAX_SEND_GUARD_PROVIDERS||
   ids.some(id=>typeof id!=='string'||id.length>200||!/^[\w.-]+:[\w.:-]+$/.test(id))||new Set(ids).size!==ids.length))
   throw Error(`指定 Provider 时请选择 1–${MAX_SEND_GUARD_PROVIDERS} 个不同的 Provider`);
  count=0;
  group(rule.conditions,1);
 }
 if('rules' in policy){
  if(!Array.isArray(policy.rules)||policy.rules.length>MAX_REMINDER_SEND_RULES+MAX_AUTOMATIC_SEND_RULES)throw Error('发送保护规则数量超出限制');
  for(const rule of policy.rules)validateRule(rule,true);
  const reminders=policy.rules.filter(rule=>rule.action==='remind').length;
  if(reminders>MAX_REMINDER_SEND_RULES||policy.rules.length-reminders>MAX_AUTOMATIC_SEND_RULES)throw Error('发送提醒或自动规则数量超出限制');
  return;
 }
 group(policy.conditions,1);
 if(policy.automatic_rules===undefined)return;
 if(!Array.isArray(policy.automatic_rules)||policy.automatic_rules.length>MAX_AUTOMATIC_SEND_RULES)
  throw Error(`自动规则最多 ${MAX_AUTOMATIC_SEND_RULES} 条`);
 for(const rule of policy.automatic_rules)validateRule(rule,false);
}
type SendGuardValues=Record<Exclude<SendGuardCondition['type'],'account_remaining_percent'>,number|null>&{account_remaining_percent?:number|null};
export function evaluateSendGuard(group:SendGuardGroup,values:SendGuardValues):boolean|null {
 const matches=group.conditions.map(c=>{
  if('conditions' in c)return evaluateSendGuard(c,values);
  const value=values[c.type];
  if(value==null)return null;
  return c.type==='account_remaining_percent'?value<=c.value:value>=c.value;
 });
 return group.operator==='and'?(matches.includes(false)?false:matches.includes(null)?null:true):(matches.includes(true)?true:matches.includes(null)?null:false);
}
