import {MAX_AUTOMATIC_SEND_RULES, SEND_GUARD_ACTION_LABELS, type SendGuardCondition, type SendGuardGroup, type SendGuardPolicy} from '../shared/send-guard.js';

export const SEND_GUARD_KEY='conversation_send_guard';
const afterIdle = (minutes: number, percent: number): SendGuardGroup => ({
 operator: 'and',
 conditions: [
  {type:'idle_minutes',value:minutes},
  {type:'context_percent',value:percent},
 ],
});
export const DEFAULT_SEND_GUARD: SendGuardPolicy = {
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
export function validateSendGuard(value:unknown):asserts value is SendGuardPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('发送保护配置无效');
 if(Object.keys(value).some(k=>!['enabled','reminder_enabled','conditions','automatic_rules'].includes(k)))throw Error('不支持的发送保护字段');
 const policy=value as SendGuardPolicy;
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
 group(policy.conditions,1);
 if(policy.automatic_rules===undefined)return;
 if(!Array.isArray(policy.automatic_rules)||policy.automatic_rules.length>MAX_AUTOMATIC_SEND_RULES)
  throw Error(`自动规则最多 ${MAX_AUTOMATIC_SEND_RULES} 条`);
 for(const rule of policy.automatic_rules){
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(k=>!['action','conditions','target'].includes(k))
   ||typeof rule.action!=='string'||!Object.hasOwn(SEND_GUARD_ACTION_LABELS,rule.action))throw Error('请选择支持的自动操作');
  if(rule.target!==undefined&&(rule.target!=='available_account'||rule.action==='compact'))throw Error('更换账号须选择新开或简要压缩');
  count=0;
  group(rule.conditions,1);
 }
}
export function usesAccountQuota(group:SendGuardGroup):boolean {
 return group.conditions.some(c=>'conditions' in c?usesAccountQuota(c):c.type==='account_remaining_percent');
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
