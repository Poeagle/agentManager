import type {ReactNode} from 'react';
import {Plus,X} from 'lucide-react';
import './ConditionGroupEditor.css';

export interface ConditionGroup<T>{operator:'and'|'or';conditions:Array<T|ConditionGroup<T>>}

interface ConditionGroupEditorProps<T> {
 group: ConditionGroup<T>;
 onChange: (value: ConditionGroup<T>) => void;
 title: string;
 heading: string;
 makeCondition: () => T;
 renderCondition: (condition: T, change: (value: T) => void, label: string) => ReactNode;
 emptyText: string;
 help: string;
 phase?: string;
 depth?: number;
 layout?: 'expression';
}

export function ConditionGroupEditor<T extends {type:string}>({group,onChange,title,heading,makeCondition,renderCondition,emptyText,help,phase,depth=1,layout}: ConditionGroupEditorProps<T>){
 const expression=layout==='expression';
 const nested=depth>1;
 const update=(index:number,value:T|ConditionGroup<T>)=>onChange({...group,conditions:group.conditions.map((c,i)=>i===index?value:c)});
 const remove=(index:number)=>onChange({...group,conditions:group.conditions.filter((_,i)=>i!==index)});
 const operatorLabel=group.operator==='and'?'且':'或';
 return <section aria-label={title} className="schedule-condition-panel" data-phase={phase} data-nested={nested} data-layout={layout}>
  <div className="rule-group-header mb-2 flex flex-wrap items-center justify-between gap-2">
   {(!expression||!nested)&&<h3 className="font-semibold">{nested?'条件组':heading}</h3>}
   <div className="rule-group-actions flex flex-wrap items-center gap-2">
    <select aria-label={`${title}组合方式`} value={group.operator} onChange={e=>onChange({...group,operator:e.target.value as 'and'|'or'})} className="rounded-md border px-2 py-1.5 text-[11px]" style={{borderColor:'var(--border)',background:'var(--bg-primary)'}}>
     <option value="and">全部满足（且）</option>
     <option value="or">任一满足（或）</option>
    </select>
    <button type="button" aria-label={`${title}添加条件`} disabled={group.conditions.length>=20} onClick={()=>onChange({...group,conditions:[...group.conditions,makeCondition()]})} className="flex items-center gap-1 text-xs" style={{color:'var(--accent)'}}><Plus size={12}/>添加条件</button>
    <button type="button" aria-label={`${title}添加分组`} disabled={depth>=4||group.conditions.length>=20} onClick={()=>onChange({...group,conditions:[...group.conditions,{operator:group.operator==='and'?'or':'and',conditions:[makeCondition()]}]})} className="flex items-center gap-1 text-xs" style={{color:'var(--accent)'}}><Plus size={12}/>分组</button>
   </div>
  </div>
  <div className="rule-conditions">
   {!group.conditions.length&&<p className="py-2 text-[11px]" style={{color:'var(--text-muted)'}}>{emptyText}</p>}
   {group.conditions.map((condition,index)=>{
    const label=`${title} ${index+1}`;
    const subgroup='conditions' in condition;
    const connector=expression&&index===0?null:<span className="rule-connector">{index===0?'当':operatorLabel}</span>;
    const row=<div className={subgroup?'rule-subgroup':'rule-row'}>
     {!expression&&connector}
     {subgroup?<ConditionGroupEditor group={condition} onChange={value=>update(index,value)} title={`${label}分组`} heading={heading} makeCondition={makeCondition} renderCondition={renderCondition} emptyText={emptyText} help={help} phase={phase} depth={depth+1} layout={layout}/>:renderCondition(condition,value=>update(index,value),label)}
     <button type="button" aria-label={`删除${label}${subgroup?'分组':''}`} onClick={()=>remove(index)} className="rule-remove" style={{color:'var(--text-muted)'}}><X size={14}/></button>
    </div>;
    const key=`${index}-${subgroup?'group':condition.type}`;
    return expression?<div key={key} className="rule-clause">{connector}{row}</div>:<div key={key}>{row}</div>;
   })}
  </div>
  {!nested&&<p className="rule-help">{help}</p>}
 </section>;
}
