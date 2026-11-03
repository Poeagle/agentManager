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
/** Recognize replies sent by the previous web version, for compact history. */
export function questionAnswers(message:ConversationMessage,later:ConversationMessage[]):string[]|null {
  const questions=message.async_questions||[];
  const native=later.flatMap(item=>item.question_replies||[]);
  if(questions.length&&questions.every(q=>q.id&&native.some(reply=>reply.question_id===q.id)))return questions.map(q=>native.find(reply=>reply.question_id===q.id)!.answer);
  for(const item of later) {
    if(item.role!=='user'||!item.text.startsWith('回复你的提问：\n'))continue;
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

export function questionReplyState(message:ConversationMessage,later:TimelineMessage[],submittedIds:string[]=[]):'pending'|'sending'|'submitted'|'queued'|'answered' {
 if(questionAnswers(message,later)===null)return message.async_questions?.length&&message.async_questions.every(question=>question.id&&submittedIds.includes(question.id))?'submitted':'pending';
 const ids=new Set(message.async_questions?.map(question=>question.id));
 const replies=later.filter(item=>item.role==='user'&&item.question_replies?.some(answer=>ids.has(answer.question_id)));
 if(replies.some(item=>item.queued))return 'queued';
 if(replies.some(item=>item.optimistic&&!item.optimistic.accepted))return 'sending';
 if(replies.some(item=>item.optimistic))return 'submitted';
 return 'answered';
}

/** Include unanswered questions outside the loaded history page. A new user
 * message or a completed turn does not implicitly answer an earlier question. */
export function pendingConversationQuestions(messages:ConversationMessage[],groups:Array<{id:string;questions:NonNullable<ConversationMessage['async_questions']>;timestamp:string|null;turn_id?:string}> = [],ignoredIds:string[]=[]):ConversationMessage[] {
  const pending=messages.filter((message,index)=>message.async_questions?.length&&questionAnswers(message,messages.slice(index+1))===null);
  for(const group of groups) {
    if(pending.some(message=>message.async_questions?.some(question=>group.questions.some(item=>item.id===question.id))))continue;
    const message:ConversationMessage={id:`pending-question-${group.id}`,role:'assistant',phase:'final',text:group.questions.map(question=>question.title).join('\n'),timestamp:group.timestamp,turn_id:group.turn_id,async_questions:group.questions};
    if(questionAnswers(message,messages)===null)pending.push(message);
  }
  const ignored=new Set(ignoredIds);
  const answered=new Set(messages.flatMap(message=>message.question_replies?.map(reply=>reply.question_id)||[]));
  return pending.map(message=>({...message,async_questions:message.async_questions?.filter(q=>!q.id||!ignored.has(q.id)&&!answered.has(q.id))})).filter(message=>message.async_questions?.length).sort((a,b)=>Date.parse(a.timestamp||'')-Date.parse(b.timestamp||''));
}
