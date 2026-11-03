import {getDb} from '../db/index.js';
import type {CodexRuntime} from './codex-runtime.js';

// A personal reminder preference, separate from native answers and execution.
export function ignoredQuestionIds(userId:string,nativeId:string|null|undefined):string[] {
  if(!nativeId)return [];
  const row=getDb().prepare('SELECT value FROM user_ui_state WHERE user_id=? AND key=?').get(userId,`ignored-questions:${nativeId}`) as {value:string}|undefined;
  try {const ids=JSON.parse(row?.value||'[]');return Array.isArray(ids)?ids.filter((id):id is string=>typeof id==='string'):[];}catch{return [];}
}

export function setIgnoredQuestions(userId:string,nativeId:string,ids:string[],ignored=true):string[] {
  return getDb().transaction(()=>{
    const values=new Set(ignoredQuestionIds(userId,nativeId));
    for(const id of ids)if(ignored)values.add(id);else values.delete(id);
    getDb().prepare(`INSERT INTO user_ui_state(user_id,key,value) VALUES(?,?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`).run(userId,`ignored-questions:${nativeId}`,JSON.stringify([...values]));
    return [...values];
  })();
}

export function personalQuestionRuntime(runtime:CodexRuntime,userId:string):CodexRuntime & {ignored_question_ids:string[]} {
  const ids=ignoredQuestionIds(userId,runtime.session_id),ignored=new Set(ids);
  const groups=(runtime.pending_questions||[]).map(group=>({...group,questions:group.questions.filter(q=>!q.id||!ignored.has(q.id))})).filter(group=>group.questions.length);
  return {...runtime,pending_questions:groups,pending_question_count:groups.reduce((n,group)=>n+group.questions.length,0),ignored_question_ids:ids};
}
