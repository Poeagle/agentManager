import type {ConversationMessage} from './api';
export type QuestionReply=NonNullable<ConversationMessage['question_replies']>[number];
const START='<send_user_message_question_reply>',END='</send_user_message_question_reply>';
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
