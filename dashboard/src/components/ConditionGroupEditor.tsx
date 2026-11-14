import type {ReactNode} from 'react';
import {Plus,X} from 'lucide-react';
import './ConditionGroupEditor.css';
export interface ConditionGroup<T>{operator:'and'|'or';conditions:Array<T|ConditionGroup<T>>}
export function ConditionGroupEditor<T extends {type:string}>({group,onChange,title,heading,makeCondition,renderCondition,emptyText,help,phase,depth=1}:{group:ConditionGroup<T>;onChange:(value:ConditionGroup<T>)=>void;title:string;heading:string;makeCondition:()=>T;renderCondition:(condition:T,change:(value:T)=>void,label:string)=>ReactNode;emptyText:string;help:string;phase?:string;depth?:number}){
 const update=(index:number,value:T|ConditionGroup<T>)=>onChange({...group,conditions:group.conditions.map((c,i)=>i===index?value:c)});
 const remove=(index:number)=>onChange({...group,conditions:group.conditions.filter((_,i)=>i!==index)});
 return <section aria-label={title} className="schedule-condition-panel" data-phase={phase} data-nested={depth>1}>
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{depth>1?'条件组':heading}</h3><div className="flex flex-wrap items-center gap-2">
   <select aria-label={`${title}组合方式`} value={group.operator} onChange={e=>onChange({...group,operator:e.target.value as 'and'|'or'})} className="rounded-md border px-2 py-1.5 text-[11px]" style={{borderColor:'var(--border)',background:'var(--bg-primary)'}}><option value="and">全部满足（且）</option><option value="or">任一满足（或）</option></select>
   <button type="button" aria-label={`${title}添加条件`} disabled={group.conditions.length>=20} onClick={()=>onChange({...group,conditions:[...group.conditions,makeCondition()]})} className="flex items-center gap-1 text-xs" style={{color:'var(--accent)'}}><Plus size={12}/>添加条件</button>
   <button type="button" aria-label={`${title}添加分组`} disabled={depth>=4||group.conditions.length>=20} onClick={()=>onChange({...group,conditions:[...group.conditions,{operator:group.operator==='and'?'or':'and',conditions:[makeCondition()]}]})} className="flex items-center gap-1 text-xs" style={{color:'var(--accent)'}}><Plus size={12}/>分组</button>
  </div></div>
  <div className="space-y-2">{!group.conditions.length&&<p className="py-2 text-[11px]" style={{color:'var(--text-muted)'}}>{emptyText}</p>}{group.conditions.map((c,index)=>{const label=`${title} ${index+1}`,connector=<span className="rule-connector">{index===0?'当':group.operator==='and'?'且':'或'}</span>;
   return 'conditions' in c?<div key={`${index}-group`} className="grid grid-cols-[22px_minmax(0,1fr)_24px] items-start gap-1">{connector}<ConditionGroupEditor group={c} onChange={value=>update(index,value)} title={`${label}分组`} heading={heading} makeCondition={makeCondition} renderCondition={renderCondition} emptyText={emptyText} help={help} phase={phase} depth={depth+1}/><button type="button" aria-label={`删除${label}分组`} onClick={()=>remove(index)}><X size={14}/></button></div>:<div key={`${index}-${c.type}`} className="rule-row">{connector}{renderCondition(c,value=>update(index,value),label)}<button type="button" aria-label={`删除${label}`} onClick={()=>remove(index)} className="flex h-7 w-7 items-center justify-center" style={{color:'var(--text-muted)'}}><X size={14}/></button></div>;
  })}</div>{depth===1&&<p className="rule-help">{help}</p>}
 </section>;
}
