import {createHash} from 'crypto';

/** Only the protocol's public message/code, never additional request details. */
export function conversationErrorMessage(turnId:string,error:unknown,willRetry:boolean,timestamp:string|null) {
  if(!error || typeof error!=='object')return null;
  const source=error as Record<string,unknown>;
  if(typeof source.message!=='string' || !source.message.trim())return null;
  const text=source.message.trim().slice(0,8000);
  const info=source.codexErrorInfo??source.codex_error_info;
  const name=typeof info==='string'?info:info && typeof info==='object'?Object.keys(info)[0]:undefined;
  const code=name?.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`).slice(0,120);
  const id=createHash('sha256').update(JSON.stringify([turnId,'error',code||'',text])).digest('hex').slice(0,32);
  return {id,role:'assistant' as const,phase:'error' as const,text,turn_id:turnId,timestamp,streaming:false,error:{...(code?{code}:{}),will_retry:willRetry}};
}
