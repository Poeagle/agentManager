/** Transport failures before dispatch are safe to report as unsent. Once a
 * mutation is dispatched only an explicit native rejection proves non-delivery. */
export class AgentSubmissionError extends Error {
  constructor(message:string,readonly submission:'rejected'|'unknown'){super(message);}
}
export class AgentQuotaExhaustedError extends AgentSubmissionError {
  readonly code='usage_limit_exceeded';
  constructor() {super('当前订阅账号额度已用尽，消息尚未发送','rejected');}
}
export class AgentQueueOccupiedError extends AgentSubmissionError {
  constructor() {
    super('目标标签页已有排队消息，跳过本次发送', 'rejected');
  }
}
export function submissionFailure(error:unknown,dispatched:boolean):Error {
 if(error instanceof Error&&['rejected','unknown'].includes((error as Error&{submission?:string}).submission||''))return error;
 return new AgentSubmissionError(dispatched?'暂未确认消息是否提交，请等待接收状态恢复后再操作':'消息尚未发送：原生连接准备失败，请重试',dispatched?'unknown':'rejected');
}
