import {currentCodexEngine} from './engine-context.js';
const values=new Map<string,{tier:string|null}>();
const key=(id:string)=>JSON.stringify([currentCodexEngine().socket,id]);
/** Native settings receipts, never inferred from a requested toggle. */
export function rememberCodexSettings(id:string,value:any):void {
 if(!value||!Object.hasOwn(value,'serviceTier')||(value.serviceTier!==null&&typeof value.serviceTier!=='string'))return;
 values.delete(key(id));values.set(key(id),{tier:value.serviceTier});
 while(values.size>1024)values.delete(values.keys().next().value!);
}
export function codexSettings(id:string){return values.get(key(id));}
