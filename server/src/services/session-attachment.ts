import {agentForSession} from './agents/index.js';
import {getSession,isSessionActive,reconnectSession,recoverSessionOnAttach} from './session-manager.js';

/** Reattach a surviving terminal only; never resume or start a new Agent. */
export async function attachExistingSession(id:string):Promise<boolean> {
  const session=getSession(id);
  if(!session || !['running','detached'].includes(session.status))return false;
  if(isSessionActive(id))return true;
  if(session.mode!=='terminal'&&agentForSession(session).descriptor.sessionHost==='managed')return recoverSessionOnAttach(id);
  if(await reconnectSession(id))return true;
  return recoverSessionOnAttach(id);
}
