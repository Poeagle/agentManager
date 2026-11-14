export type SendGuardCondition={type:'context_percent'|'context_tokens'|'idle_minutes';value:number};
export interface SendGuardGroup {operator:'and'|'or';conditions:Array<SendGuardCondition|SendGuardGroup>}
export interface SendGuardPolicy {enabled:boolean;conditions:SendGuardGroup}
export const SEND_GUARD_KEY='conversation_send_guard';
export const DEFAULT_SEND_GUARD:SendGuardPolicy={enabled:true,conditions:{operator:'or',conditions:[{type:'context_percent',value:80},{operator:'and',conditions:[{type:'context_percent',value:50},{type:'idle_minutes',value:30}]}]}};
export function validateSendGuard(value:unknown):asserts value is SendGuardPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('发送保护配置无效');
 if(Object.keys(value).some(k=>!['enabled','conditions'].includes(k)))throw Error('不支持的发送保护字段');
 const policy=value as SendGuardPolicy;if(typeof policy.enabled!=='boolean')throw Error('请设置发送保护开关');let count=0;
 function group(raw:unknown,depth:number){
  const g=raw as SendGuardGroup;
  if(!g||typeof g!=='object'||Array.isArray(g)||!['and','or'].includes(g.operator)||!Array.isArray(g.conditions))throw Error('条件组请选择且／或');
  if(Object.keys(g).some(k=>!['operator','conditions'].includes(k)))throw Error('不支持的条件组字段');
  if(depth>4||g.conditions.length>20||!g.conditions.length)throw Error('条件组须有 1–20 项，最多 4 层');
  for(const item of g.conditions){if(++count>50)throw Error('条件最多 50 项（含分组）');if(!item||typeof item!=='object')throw Error('条件无效');if('conditions' in item||'operator' in item){group(item,depth+1);continue;}
   if(Object.keys(item).some(k=>!['type','value'].includes(k)))throw Error('不支持的条件字段');
   const c=item as SendGuardCondition,max=c.type==='context_percent'?100:c.type==='idle_minutes'?10080:c.type==='context_tokens'?2000000:0;
   if(!max||!Number.isInteger(c.value)||c.value<1||c.value>max)throw Error(`条件数值须为 1–${max||100} 的整数`);
  }
 }
 group(policy.conditions,1);
}
export function evaluateSendGuard(group:SendGuardGroup,values:Record<SendGuardCondition['type'],number|null>):boolean|null {
 const matches=group.conditions.map(c=>'conditions' in c?evaluateSendGuard(c,values):values[c.type]===null?null:values[c.type]!>=c.value);
 return group.operator==='and'?(matches.includes(false)?false:matches.includes(null)?null:true):(matches.includes(true)?true:matches.includes(null)?null:false);
}
