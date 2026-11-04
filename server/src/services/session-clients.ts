import {agentDescriptors} from './agents/index.js';
/** Client choices exposed by project authorization and Session launchers. */
export function sessionClients(){return agentDescriptors().sort((a,b)=>(a.presentation.order??100)-(b.presentation.order??100)).filter(agent=>agent.capabilities.launch).map(({id,label})=>({id,label}));}
/** Legacy export; new callers use the live registry. */
export const SESSION_CLIENTS=sessionClients();

export function parseSessionClients(value: string): string[] {
  try {
    const clients: unknown = JSON.parse(value);
    return Array.isArray(clients) ? [...new Set(clients.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}
