import { createHash } from 'crypto';
import { conversationAsyncQuestions, conversationQuestionReply } from '../../conversation-interactions.js';
import { conversationErrorMessage } from '../../conversation-error.js';
import { conversationImagePaths } from '../../conversation-attachments.js';
import { decodeCodexText } from './text.js';
const MAX_RECORD = 512 * 1024;
export function codexTurnBoundary(record: Buffer): {kind:'start'|'end';turnId:string} | null {
    if (record.length > MAX_RECORD || !/"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|turn_context)"/.test(record.subarray(0,400).toString('utf8'))) return null;
    try {
        const entry=JSON.parse(record.toString('utf8')),p=entry.payload;
        const kind=entry.type==='turn_context'||entry.type==='event_msg'&&p?.type==='task_started'?'start'
            :entry.type==='event_msg'&&['task_complete','turn_aborted'].includes(p?.type)?'end':null;
        return kind&&typeof p?.turn_id==='string'?{kind,turnId:p.turn_id}:null;
    } catch { return null; }
}
export function codexRecordLimit(buffer: Buffer) { const header = buffer.subarray(0, 4096).toString('utf8'), position = header.indexOf('"payload"'), payload = header.slice(position); return position >= 0 && /^"payload"\s*:\s*\{\s*"type"\s*:\s*"message"/.test(payload) && /"role"\s*:\s*"([^"]+)"/.exec(payload)?.[1] === 'user' ? 16 * 1024 * 1024 : MAX_RECORD; }
export function codexQuestionCall(record: Buffer) {
    if (record.length > MAX_RECORD || !/"name"\s*:\s*"request_user_input_async"/.test(record.subarray(0, 800).toString()))
        return null;
    try {
        const p = JSON.parse(record.toString()).payload;
        if (p?.type !== 'function_call' || p.name !== 'request_user_input_async' || typeof p.call_id !== 'string' || p.call_id.length > 200 || typeof p.arguments !== 'string')
            return null;
        const questions = conversationAsyncQuestions({ ...JSON.parse(p.arguments), delivery: 'async', id: p.call_id });
        if (!questions)
            return null;
        return { id: p.call_id, turnId: typeof p.internal_chat_message_metadata_passthrough?.turn_id === 'string' ? p.internal_chat_message_metadata_passthrough.turn_id : undefined, signature: createHash('sha256').update(JSON.stringify(questions.map(q => ({ title: q.title, options: q.options })))).digest('hex') };
    }
    catch {
        return null;
    }
}
export function parseCodexMessage(line: Buffer, questionCallId?: string) {
    if (line.length > codexRecordLimit(line))
        return null;
    let text = line.toString('utf8');
    if (line.length > MAX_RECORD)
        text = text.replace(/"image_url"\s*:\s*"data:[^"]*"/g, '"image_url":""');
    // Do not parse or retain tool results/reasoning. The extractor also checks
    // the actual JSON structure so quoted records in tool output cannot leak.
    const header = text.slice(0, 400);
    const agentItem = /"type"\s*:\s*"item_completed"/.test(header) && /"type"\s*:\s*"AgentMessage"/.test(header);
    if (!agentItem && !/"(?:type|role)"\s*:\s*"(?:user|assistant|message|user_message|agent_message|task_complete|error)"/.test(text.slice(0, 400)))
        return null;
    try {
        const entry = JSON.parse(text);
        const turnId = entry.payload?.turn_id || entry.payload?.internal_chat_message_metadata_passthrough?.turn_id;
        const failure = entry.type === 'event_msg' && ['task_complete', 'error'].includes(entry.payload?.type)
            ? conversationErrorMessage(typeof turnId === 'string' ? turnId : `event:${entry.timestamp}`, entry.payload.error ?? (entry.payload.type === 'error' ? entry.payload : null), entry.payload.will_retry === true || entry.payload.willRetry === true, typeof entry.timestamp === 'string' ? entry.timestamp : null) : null;
        const asyncItem = entry.type === 'event_msg' && entry.payload?.type === 'item_completed' && entry.payload.item?.type === 'AgentMessage' ? entry.payload.item
            : entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant' ? entry.payload : null;
        const nativeAsyncItem = asyncItem ?? (entry.type === 'event_msg' && entry.payload?.type === 'agent_message' ? entry.payload : null);
        const asyncQuestions = conversationAsyncQuestions(questionCallId ? { ...nativeAsyncItem, id: questionCallId } : nativeAsyncItem);
        const asyncMessage = asyncQuestions ? { role: 'assistant' as const, phase: 'final' as const, text: (typeof nativeAsyncItem.message === 'string' ? nativeAsyncItem.message : (nativeAsyncItem.content || []).filter((part: any) => ['Text', 'output_text'].includes(part.type) && typeof part.text === 'string').map((part: any) => part.text).join('\n')).slice(0, 128 * 1024) || asyncQuestions.map(q => q.title).join('\n'), timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null } : null;
        // Show only our explicit, credential-free resource notice. Other developer
        // instructions remain outside the public transcript. This is presentation
        // only: no user message is submitted to the native thread.
        // thread/start can coalesce developerInstructions with permissions and
        // other private instructions as separate blocks in one native message.
        // Select only the platform's complete wrapper, never join those blocks.
        const developerText = entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'developer'
            ? (entry.payload.content || []).filter((part: any) => part.type === 'input_text' && typeof part.text === 'string').map((part: any) => part.text.trim()).find((text: string) => /^<octoally_shared_resources>\n[\s\S]*\n<\/octoally_shared_resources>$/.test(text)) : undefined;
        const shared = developerText
            ? { role: 'user' as const, phase: 'user' as const, text: developerText, timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null } : null;
        const extracted = shared || failure || asyncMessage || decodeCodexText([entry], 128 * 1024).find(message => message.role === 'user' || message.role === 'assistant');
        const reply = extracted?.role === 'user' ? conversationQuestionReply(extracted.text) : undefined;
        const message = reply ? { ...extracted!, text: reply.text } : extracted;
        const itemId = asyncQuestions && typeof nativeAsyncItem?.id === 'string' ? nativeAsyncItem.id : entry.type === 'response_item' && typeof entry.payload?.id === 'string' ? entry.payload.id : undefined;
        return message ? { message, failure, itemId, asyncQuestions, questionReplies: reply?.answers, imagePaths: message.role === 'user' ? conversationImagePaths(entry.payload?.content) : [], turnId: typeof turnId === 'string' ? turnId : undefined, recordType: asyncQuestions ? 'async_question' : entry.type === 'event_msg' ? (entry.payload?.type === 'task_complete' ? 'completion_echo' : 'event_message') : 'native_message' } : null;
    }
    catch {
        return null;
    }
}
