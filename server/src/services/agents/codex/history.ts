import { createHash } from 'crypto';
import { conversationAsyncQuestions, conversationQuestionReply } from '../../conversation-interactions.js';
import { conversationErrorMessage } from '../../conversation-error.js';
import { conversationImagePaths } from '../../conversation-attachments.js';
import type { AgentHistoryRecord } from '../types.js';
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
const MAX_COMPACTED_RECORD = 16 * 1024 * 1024;
const parsedRecords = new WeakMap<Buffer, any>();
export function codexHistoryReplacementIndexes(line: Buffer): number[] | null {
    if (line.length > MAX_COMPACTED_RECORD || !/"type"\s*:\s*"compacted"/.test(line.subarray(0, 400).toString('utf8'))) return null;
    try {
        const entry = JSON.parse(line.toString('utf8'));
        parsedRecords.set(line, entry);
        if (entry.type !== 'compacted') return null;
        return Array.isArray(entry.payload?.replacement_history)
            ? entry.payload.replacement_history.map((_: unknown, index: number) => index)
            : [];
    } catch { return null; }
}
export function codexRecordLimitWithCompaction(buffer: Buffer) {
    return /"type"\s*:\s*"compacted"/.test(buffer.subarray(0, 400).toString('utf8'))
        ? MAX_COMPACTED_RECORD
        : codexRecordLimit(buffer);
}
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
export function parseCodexMessage(line: Buffer, questionCallId?: string, context?: {nativeId?: string | null; replacementIndex?: number}): AgentHistoryRecord | null {
    if (line.length > codexRecordLimitWithCompaction(line))
        return null;
    if (typeof context?.replacementIndex === 'number') {
        try {
            const entry = parsedRecords.get(line) ?? JSON.parse(line.toString('utf8'));
            if (entry.type === 'compacted') parsedRecords.set(line, entry);
            const item = entry.type === 'compacted' && entry.payload?.replacement_history?.[context.replacementIndex];
            if (!item || typeof item !== 'object') return null;
            if (item.type === 'compaction' && typeof item.encrypted_content === 'string' && item.encrypted_content && !(typeof entry.payload?.message === 'string' && entry.payload.message.trim())) {
                return {
                    message: {role: 'assistant', phase: 'commentary', text: '压缩内容由 Codex 加密保存，无法显示摘要正文。', timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null},
                    presentation: 'compaction_summary',
                    compaction: {before_tokens: finiteTokenCount(entry.payload?.latest_token_usage_record?.usage?.input_tokens), after_tokens: finiteTokenCount(entry.payload?.post_compaction_token_count), duration_ms: finiteTokenCount(entry.payload?.duration_ms)},
                    itemId: typeof item.id === 'string' ? item.id : undefined,
                    recordType: 'compaction_summary', imagePaths: [],
                };
            }
            const compactedText = typeof entry.payload?.message === 'string' ? entry.payload.message : '';
            const itemText = Array.isArray(item.content)
                ? item.content.filter((part: any) => ['input_text', 'text', 'output_text', 'Text'].includes(part?.type) && typeof part.text === 'string').map((part: any) => part.text).join('\n')
                : '';
            const markedSummary = itemText.match(/^<COMPACTION_SUMMARY>\r?\n([\s\S]*)$/);
            if (item.role === 'user' && markedSummary?.[1].trim()) {
                return {
                    message: {role: 'assistant', phase: 'commentary', text: markedSummary[1].trim().slice(0, 128 * 1024), timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null},
                    presentation: 'compaction_summary',
                    compaction: {
                        before_tokens: finiteTokenCount(entry.payload?.latest_token_usage_record?.usage?.input_tokens),
                        after_tokens: finiteTokenCount(entry.payload?.post_compaction_token_count),
                        duration_ms: finiteTokenCount(entry.payload?.duration_ms),
                    },
                    itemId: typeof item.id === 'string' ? item.id : undefined,
                    recordType: 'compaction_summary',
                    imagePaths: [],
                };
            }
            // Codex stores the compaction summary both as compacted.message and
            // as the final user item in replacement_history. The latter's
            // native item ID is the durable identity for this summary card.
            if (item.role === 'user' && compactedText && itemText === compactedText) {
                const summary = parseCodexMessage(line, questionCallId, {nativeId: context.nativeId});
                return summary ? {...summary, itemId: typeof item.id === 'string' ? item.id : summary.itemId} : null;
            }
            const wrapped = Buffer.from(JSON.stringify({type: 'response_item', timestamp: entry.timestamp, payload: item}));
            return parseCodexMessage(wrapped, questionCallId, {nativeId: context.nativeId});
        } catch {
            return null;
        }
    }
    let text = line.toString('utf8');
    if (line.length > MAX_RECORD)
        text = text.replace(/"image_url"\s*:\s*"data:[^"]*"/g, '"image_url":""');
    // Do not parse or retain tool results/reasoning. The extractor also checks
    // the actual JSON structure so quoted records in tool output cannot leak.
    const header = text.slice(0, 400);
    const completedItem = /"type"\s*:\s*"item_completed"/.test(header);
    const agentItem = completedItem && /"type"\s*:\s*"AgentMessage"/.test(header);
    const userItem = completedItem && /"type"\s*:\s*"UserMessage"/.test(header);
    const compactionSummary = /"type"\s*:\s*"compacted"/.test(header);
    if (!compactionSummary && !agentItem && !userItem && !/"(?:type|role)"\s*:\s*"(?:user|assistant|message|user_message|agent_message|task_complete|error)"/.test(text.slice(0, 400)))
        return null;
    try {
        const entry = parsedRecords.get(line) ?? JSON.parse(text);
        if (entry.type === 'compacted') parsedRecords.set(line, entry);
        if (compactionSummary && entry.type === 'compacted') {
            const nativeId = typeof entry.payload.compaction_response_id === 'string' ? entry.payload.compaction_response_id : typeof entry.payload.window_id === 'string' ? `compaction:${entry.payload.window_id}` : undefined;
            const summary = typeof entry.payload?.message === 'string' && entry.payload.message.trim() ? entry.payload.message : 'Codex 未提供可显示的压缩摘要正文。';
            return {
                message: { role: 'assistant' as const, phase: 'commentary' as const, text: summary.slice(0, 128 * 1024), timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null },
                presentation: 'compaction_summary' as const,
                compaction: {
                    before_tokens: finiteTokenCount(entry.payload.latest_token_usage_record?.usage?.input_tokens),
                    after_tokens: finiteTokenCount(entry.payload.post_compaction_token_count),
                    duration_ms: finiteTokenCount(entry.payload.duration_ms),
                },
                itemId: nativeId,
                turnId: undefined,
                recordType: 'compaction_summary',
                imagePaths: [],
            };
        }
        const declared = entry.payload?.turn_id || entry.payload?.internal_chat_message_metadata_passthrough?.turn_id;
        // Some native event echoes incorrectly store the thread UUID as turn_id.
        // Discard that alias so lifecycle boundaries supply the real turn.
        const turnId = declared === context?.nativeId ? undefined : declared;
        const failure = entry.type === 'event_msg' && ['task_complete', 'error'].includes(entry.payload?.type)
            ? conversationErrorMessage(typeof turnId === 'string' ? turnId : `event:${entry.timestamp}`, entry.payload.error ?? (entry.payload.type === 'error' ? entry.payload : null), entry.payload.will_retry === true || entry.payload.willRetry === true, typeof entry.timestamp === 'string' ? entry.timestamp : null) : null;
        const asyncItem = entry.type === 'event_msg' && entry.payload?.type === 'item_completed' && entry.payload.item?.type === 'AgentMessage' ? entry.payload.item
            : entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant' ? entry.payload : null;
        const completedUserItem = userItem && entry.type === 'event_msg' && entry.payload?.type === 'item_completed' ? entry.payload.item : null;
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
        const reply = extracted?.role === 'user' ? conversationQuestionReply(extracted.text,Array.isArray(entry.payload?.content)&&entry.payload.content.some((part:any)=>part?.type==='input_image')) : undefined;
        const message = reply ? { ...extracted!, text: reply.text } : extracted;
        const itemId = typeof asyncItem?.id === 'string' ? asyncItem.id : typeof completedUserItem?.id === 'string' ? completedUserItem.id : entry.type === 'response_item' && typeof entry.payload?.id === 'string' ? entry.payload.id : undefined;
        const clientId = typeof completedUserItem?.client_id === 'string' ? completedUserItem.client_id : typeof completedUserItem?.clientId === 'string' ? completedUserItem.clientId : undefined;
        const imageContent = completedUserItem && Array.isArray(completedUserItem.content)
            ? completedUserItem.content.map((part: any) => part?.type === 'local_image' ? {...part,type:'localImage'} : part)
            : entry.payload?.content;
        return message ? { message: message as AgentHistoryRecord['message'], failure, itemId, ...(clientId ? {clientId} : {}), asyncQuestions, questionReplies: reply?.answers, imagePaths: message.role === 'user' ? conversationImagePaths(imageContent) : [], turnId: typeof turnId === 'string' ? turnId : undefined, recordType: shared ? 'shared_context' : asyncQuestions ? 'async_question' : userItem ? 'event_user_item' : entry.type === 'event_msg' ? (entry.payload?.type === 'task_complete' ? 'completion_echo' : 'event_message') : 'native_message' } : null;
    }
    catch {
        return null;
    }
}
function finiteTokenCount(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
