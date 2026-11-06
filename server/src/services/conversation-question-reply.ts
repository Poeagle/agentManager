const object=(value:unknown):value is Record<string,any>=>!!value && typeof value==='object' && !Array.isArray(value);

export interface ConversationQuestionReply {question_id:string;question:string;answer:string}
/** Match Codex's complete reply envelope. It resolves the same question in
 * other attached clients; quoted/partial JSON remains ordinary user text. */
export function conversationQuestionReply(text:string,repairNativeImages=false):{text:string;answers:ConversationQuestionReply[]}|undefined {
  // Older platform uploads inserted editor image spans into the JSON wrapper.
  // Repair only when the native input independently contains an actual image;
  // ordinary text and quoted envelopes keep the strict default interpretation.
  if(repairNativeImages)return conversationQuestionReply(text)??conversationQuestionReply(text.replace(/\[Image #\d+\]/g,''));
  let value=text.trim();
  if(value.startsWith('# Context from my IDE setup:\n')) {const marker='\n## My request for Codex:\n',offset=value.lastIndexOf(marker);if(offset<0)return;value=value.slice(offset+marker.length).trim();}
  const start='<send_user_message_question_reply>',end='</send_user_message_question_reply>';
  if(!value.startsWith(start))return;
  const boundary=value.lastIndexOf(end);if(boundary<start.length)return;
  // Native image spans and file references are appended to the user input.
  // Keep resolving the original question, but reject arbitrary trailing text.
  const suffix=value.slice(boundary+end.length).trim();
  if(suffix&&!/^(?:\[Image #\d+\]\s*)*(?:附件：\n(?:- [^\r\n]+: \/[^\r\n]+(?:\n|$)){1,8})?$/.test(suffix))return;
  value=value.slice(0,boundary+end.length);
  try {
    const parsed=JSON.parse(value.slice(start.length,-end.length)),items=Array.isArray(parsed)?parsed:[parsed];
    if(!items.length||items.length>20)return;
    const answers:ConversationQuestionReply[]=[];
    for(const q of items) {
      if(!object(q)||typeof q.questionItemId!=='string'||!q.questionItemId||q.questionItemId.length>512||typeof q.question!=='string'||q.question.length>12000||typeof q.answer!=='string'||q.answer.length>128*1024)return;
      answers.push({question_id:q.questionItemId,question:q.question,answer:q.answer});
    }
    return {text:'回复你的提问：\n'+answers.map((q,index)=>`${index+1}. ${q.question}\n我的回答：${q.answer}`).join('\n\n'),answers};
  }catch{return;}
}
