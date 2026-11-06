import {conversationQuestionReply} from '../../conversation-question-reply.js';

const END='</send_user_message_question_reply>';
/** Compatibility with Codex TUI's strict parse_input(): only one text input
 * containing a complete reply envelope resolves questions in the terminal.
 * This changes terminal receipts only. Requests and durable engine history
 * retain the original text, images, file references and client identity. */
function projectItem(item:any):any {
  if(item?.type!=='userMessage'||!Array.isArray(item.content))return item;
  const content=item.content.filter((part:any)=>!['skill','mention'].includes(part?.type));
  const texts=content.filter((part:any)=>part?.type==='text'&&typeof part.text==='string');
  if(texts.length!==1)return item;
  const text=texts[0].text;
  if(content.length===1&&text.trim().endsWith(END))return item;
  const reply=conversationQuestionReply(text,content.some((part:any)=>['image','localImage'].includes(part?.type)));if(!reply)return item;
  const canonical='<send_user_message_question_reply>\n'+JSON.stringify(reply.answers.map(answer=>({questionItemId:answer.question_id,question:answer.question,answer:answer.answer})))+'\n'+END;
  return {...item,content:[{type:'text',text:canonical,text_elements:[]}]};
}
function mapItems(items:any):any {
  if(!Array.isArray(items))return items;
  let changed=false;const next=items.map(item=>{const result=projectItem(item);changed ||= result!==item;return result;});return changed?next:items;
}
function projectTurn(turn:any):any {if(!turn||!Array.isArray(turn.items))return turn;const items=mapItems(turn.items);return items===turn.items?turn:{...turn,items};}
function projectTurns(turns:any):any {
  if(!Array.isArray(turns))return turns;
  let changed=false;const next=turns.map(turn=>{const result=projectTurn(turn);changed ||= result!==turn;return result;});return changed?next:turns;
}
export const terminalHistoryMethods=new Set(['thread/read','thread/resume','thread/fork','thread/turns/list','thread/items/list','thread/items/read','turn/start','turn/steer']);
/** Do not recursively inspect arbitrary tool output or provider extensions. */
export function projectCodexTerminalFrame(frame:any,responseMethod?:string):any {
  if(['item/started','item/completed'].includes(frame?.method)){
    const item=projectItem(frame.params?.item);return item===frame.params?.item?frame:{...frame,params:{...frame.params,item}};
  }
  if(['turn/started','turn/completed'].includes(frame?.method)){
    const turn=projectTurn(frame.params?.turn);return turn===frame.params?.turn?frame:{...frame,params:{...frame.params,turn}};
  }
  if(!responseMethod||!terminalHistoryMethods.has(responseMethod)||!frame.result)return frame;
  const original=frame.result;let result=original;
  const replace=(key:string,value:any)=>{if(value!==original[key]){if(result===original)result={...original};result[key]=value;}};
  if(original.thread?.turns){const turns=projectTurns(original.thread.turns);if(turns!==original.thread.turns)replace('thread',{...original.thread,turns});}
  if(original.turn)replace('turn',projectTurn(original.turn));
  if(responseMethod==='thread/turns/list')replace('data',projectTurns(original.data));
  if(['thread/items/list','thread/items/read'].includes(responseMethod)){
    for(const key of ['data','items'])if(Array.isArray(original[key])){
      let changed=false;const values=original[key].map((entry:any)=>{const item=projectItem(entry?.item??entry);if(item===(entry?.item??entry))return entry;changed=true;return entry?.item?{...entry,item}:item;});if(changed)replace(key,values);
    }
  }
  return result===original?frame:{...frame,result};
}
