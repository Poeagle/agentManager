import {api, type SendGuardPayload} from './api';
import {prepareBriefSend as prepare} from '../../../server/src/shared/conversation-brief';
export {parseBriefContext, prependBriefPayload} from '../../../server/src/shared/conversation-brief';
export type {BriefContext, BriefTurn} from '../../../server/src/shared/conversation-brief';

export function prepareBriefSend(sessionId: string, nativeId: string, payload: SendGuardPayload, signal: AbortSignal): Promise<SendGuardPayload> {
  return prepare(sessionId, nativeId, payload, query => api.agent.conversation(sessionId, query, signal));
}
