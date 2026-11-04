export interface AgentCompaction {id:string;status:'running'|'completed'|'failed'|'interrupted';started_at:string|null;completed_at:string|null;duration_ms:number|null}
export type AgentFeature='history'|'runtime'|'input'|'stream'|'controls'|'model'|'effort'|'compact'|'newConversation'|'reload'|'interrupt'|'questions'|'usage'|'statistics'|'retry'|'launch'|'resume'|'attachments'|'sharedResources'|'quota';
export interface AgentDescriptor {terminal?:{composer:boolean;repaintOnResize:boolean};sessionHost?:'terminal'|'managed';id:string;label:string;capabilities:Record<AgentFeature,boolean>;presentation:{icon:string;color:string}}
export interface AgentSessionInfo {agent?:AgentDescriptor;agent_id?:string|null;cli_type?:string|null;native_session_id?:string|null;codex_session_id?:string|null;claude_session_id?:string|null}
const all:AgentFeature[]=['history','runtime','input','stream','controls','model','effort','compact','newConversation','reload','interrupt','questions','usage','statistics','retry','launch','resume','attachments','sharedResources','quota'];
const capabilities=(supported:AgentFeature[])=>Object.fromEntries(all.map(feature=>[feature,supported.includes(feature)])) as AgentDescriptor['capabilities'];
// Compatibility for saved browser state and older servers. Live descriptors
// come from the provider registry in every session response; unknown agents
// never inherit another provider's capabilities or native conversation ID.
const legacy:Record<string,AgentDescriptor>={
 codex:{terminal:{composer:true,repaintOnResize:true},sessionHost:'terminal',id:'codex',label:'Codex',capabilities:capabilities(all),presentation:{icon:'codex',color:'#60a5fa'}},
 claude:{terminal:{composer:true,repaintOnResize:false},sessionHost:'terminal',id:'claude',label:'Claude',capabilities:capabilities(all.filter(feature=>!['runtime','effort','questions','statistics','retry','quota'].includes(feature))),presentation:{icon:'claude',color:'#D97757'}},
};
const legacyIds:Record<string,'codex_session_id'|'claude_session_id'>={codex:'codex_session_id',claude:'claude_session_id'};
export function sessionAgent(session:AgentSessionInfo):AgentDescriptor {
 const id=session.agent_id||session.cli_type||(session.codex_session_id&&!session.claude_session_id?'codex':'claude');return session.agent??legacy[id]??{id,label:id,capabilities:capabilities([]),presentation:{icon:'agent',color:'#6b7280'}};
}
export function agentNativeId(session:AgentSessionInfo):string|null {if(session.native_session_id!==undefined)return session.native_session_id;const field=legacyIds[sessionAgent(session).id];return field?session[field]??null:null;}
export function agentSupports(session:AgentSessionInfo,feature:AgentFeature):boolean{return !!sessionAgent(session).capabilities[feature];}

export function builtinAgentDescriptors():AgentDescriptor[]{return [legacy.claude,legacy.codex];}
