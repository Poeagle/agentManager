import type { AgentMessage as ConversationMessage } from './types.js';
import type { ConversationInteraction } from '../conversation-interactions.js';
import type { ConversationActivity } from '../conversation-activity.js';
import type { ConversationUsageFrame } from '../conversation-usage.js';
export interface AgentCompaction {
    id: string;
    status: 'running' | 'completed' | 'failed' | 'interrupted';
    started_at: string | null;
    completed_at: string | null;
    duration_ms: number | null;
}
type AgentStreamEvent = {
    type: 'queue';
    messages: ConversationMessage[];
} | ConversationUsageFrame | {
    type: 'settings';
    model: string;
    effort: string | null;
} | {
    type: 'snapshot';
    messages: ConversationMessage[];
    interactions: ConversationInteraction[];
    activities: ConversationActivity[];
    compaction: AgentCompaction | null;
    busy: boolean;
    connected: true;
    turn_id: string | null;
    started_at: string | null;
    completed_at: string | null;
    stage: 'waiting' | 'tools' | 'answering' | 'finishing' | 'idle';
} | {
    type: 'unavailable';
    reason: string;
    reconnect?: boolean;
    retrying?:boolean;
};

export type AgentStreamSnapshot=Extract<AgentStreamEvent,{type:'snapshot'}>;
export interface AgentStreamPatch {type:'patch';upserts:ConversationMessage[];deltas:Array<{id:string;offset:number;text:string}>;state?:Omit<AgentStreamSnapshot,'type'|'messages'>}
export type AgentStreamFrame=(AgentStreamEvent|AgentStreamPatch)&{stream_id?:string;stream_seq?:number;baseline?:boolean};
