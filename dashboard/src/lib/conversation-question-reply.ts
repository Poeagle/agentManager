import type {ConversationMessage} from './api';
import type {TimelineMessage} from './conversation-timeline';
export type QuestionReply=NonNullable<ConversationMessage['question_replies']>[number];
const START='<send_user_message_question_reply>',END='</send_user_message_question_reply>';
/** Keep native reply identity and context in the message; display the user's
 * answer once, alongside the original question's separate history card. */
export function questionReplyDisplayText(message:ConversationMessage):string {
  const replies=message.role==='user'?message.question_replies:undefined;
  return replies?.length?replies.map((reply,index)=>`${replies.length>1?`${index+1}. `:''}${reply.answer}`).join('\n\n'):message.text;
}
export function encodeQuestionReply(answers:QuestionReply[]) {
  return START+'\n'+JSON.stringify(answers.map(q=>({questionItemId:q.question_id,question:q.question,answer:q.answer})))+'\n'+END;
}
export function decodeQuestionReply(text:string):{text:string;answers:QuestionReply[]}|undefined {
  const value=text.trim();if(!value.startsWith(START)||!value.endsWith(END))return;
  try {
    const parsed=JSON.parse(value.slice(START.length,-END.length)),items=Array.isArray(parsed)?parsed:[parsed];
    if(!items.length||items.length>20||items.some(q=>!q||typeof q.questionItemId!=='string'||typeof q.question!=='string'||typeof q.answer!=='string'))return;
    const answers=items.map(q=>({question_id:q.questionItemId,question:q.question,answer:q.answer}));
    return {answers,text:'回复你的提问：\n'+answers.map((q,index)=>`${index+1}. ${q.question}\n我的回答：${q.answer}`).join('\n\n')};
  }catch{return;}
}
/** Legacy answers have no IDs; only later, explicitly formatted user messages
 * can match them. Structured native IDs remain authoritative across replay. */
function legacyAnswers(message:ConversationMessage,later:TimelineMessage[]):string[]|null {
  const questions=message.async_questions||[];
  for(const item of later) {
    const answers=questions.map((q,index)=>{
      const marker=`${index+1}. ${q.title}\n我的回答：`,start=item.text.indexOf(marker);
      if(start<0)return null;
      const next=questions[index+1]?item.text.indexOf(`\n\n${index+2}. ${questions[index+1].title}\n我的回答：`,start+marker.length):-1;
      return item.text.slice(start+marker.length,next<0?undefined:next).trim();
    });
    if(answers.length&&answers.every(answer=>answer!==null))return answers as string[];
  }
  return null;
}
export type QuestionState='pending'|'sending'|'submitted'|'queued'|'answered';
type PendingGroup={id:string;questions:NonNullable<ConversationMessage['async_questions']>;timestamp:string|null;turn_id?:string};
/** One metadata index serves question cards, pending attention and answer state.
 * Body-only deltas never require rescanning every answer for every question. */
export function indexConversationQuestions(messages:TimelineMessage[]) {
  const replies=new Map<string,{answer:string;rank:number}>(),questions:TimelineMessage[]=[],positions=new Map<string,number>(),legacy:Array<{index:number;message:TimelineMessage}>=[];
  messages.forEach((message,index)=>{
    positions.set(message.id,index);
    if(message.async_questions?.length)questions.push(message);
    if(message.role!=='user')return;
    const rank=!message.queued&&!message.optimistic?3:message.queued?1:message.optimistic?.accepted?2:0;
    for(const reply of message.question_replies||[]){const previous=replies.get(reply.question_id);if(!previous||rank>=previous.rank)replies.set(reply.question_id,{answer:reply.answer,rank});}
    if(!message.question_replies?.length&&message.text.startsWith('回复你的提问：\n'))legacy.push({index,message});
  });
  const cached=new WeakMap<ConversationMessage,string[]|null>();
  function answers(message:ConversationMessage):string[]|null {
    if(cached.has(message))return cached.get(message)!;
    const set=message.async_questions||[];
    const result=set.length&&set.every(question=>question.id&&replies.has(question.id))?set.map(question=>replies.get(question.id!)!.answer)
      :legacyAnswers(message,legacy.filter(item=>item.index>(positions.get(message.id)??-1)).map(item=>item.message));
    cached.set(message,result);return result;
  }
  function state(message:ConversationMessage,submittedIds:string[]=[]):QuestionState {
    const set=message.async_questions||[];
    if(answers(message)===null)return set.length&&set.every(question=>question.id&&submittedIds.includes(question.id))?'submitted':'pending';
    const rank=Math.min(3,...set.map(question=>replies.get(question.id||'')?.rank??3));
    return rank===0?'sending':rank===1?'queued':rank===2?'submitted':'answered';
  }
  function pending(groups:PendingGroup[]=[],ignoredIds:string[]=[]):ConversationMessage[]{
    const ignored=new Set(ignoredIds),seen=new Set<string>(),result:ConversationMessage[]=[];
    function add(message:ConversationMessage){
      if(answers(message)!==null)return;
      const remaining=message.async_questions?.filter(question=>!question.id||!ignored.has(question.id)&&!replies.has(question.id)&&!seen.has(question.id));
      if(!remaining?.length)return;
      for(const question of remaining)if(question.id)seen.add(question.id);
      result.push(remaining.length===message.async_questions?.length?message:{...message,async_questions:remaining});
    }
    for(const question of questions)add(question);
    for(const group of groups)add({id:`pending-question-${group.id}`,role:'assistant',phase:'final',text:group.questions.map(question=>question.title).join('\n'),timestamp:group.timestamp,turn_id:group.turn_id,async_questions:group.questions});
    return result.sort((a,b)=>Date.parse(a.timestamp||'')-Date.parse(b.timestamp||''));
  }
  return {answers,state,pending};
}
/** Retain the index across streaming text changes and one-second UI clocks. */
export function createConversationQuestionCache(){
  let previous:TimelineMessage[]=[],index:ReturnType<typeof indexConversationQuestions>|undefined;
  return {read(messages:TimelineMessage[]){
    const relevant=messages.filter(message=>message.async_questions?.length||message.role==='user'&&(message.question_replies?.length||message.text.startsWith('回复你的提问：\n')));
    if(!index||relevant.length!==previous.length||relevant.some((message,i)=>message!==previous[i])){previous=relevant;index=indexConversationQuestions(relevant);}
    return index;
  }};
}
export function questionAnswers(message:ConversationMessage,later:ConversationMessage[]):string[]|null{return indexConversationQuestions(later).answers(message);}
export function questionReplyState(message:ConversationMessage,later:TimelineMessage[],submittedIds:string[]=[]):QuestionState{return indexConversationQuestions(later).state(message,submittedIds);}
export function pendingConversationQuestions(messages:ConversationMessage[],groups:PendingGroup[]=[],ignoredIds:string[]=[]):ConversationMessage[]{return indexConversationQuestions(messages).pending(groups,ignoredIds);}
