import { decodeClaudeText } from './text.js';
import { conversationQuestionReply } from '../../conversation-interactions.js';
export function claudeRecordLimit(buffer: Buffer) { const header = buffer.subarray(0, 4096).toString('utf8'); return /"type"\s*:\s*"([^"]+)"/.exec(header)?.[1] === 'user' && !/"type"\s*:\s*"tool_result"/.test(header) ? 16 * 1024 * 1024 : 512 * 1024; }
export function parseClaudeMessage(line: Buffer) { if (line.length > claudeRecordLimit(line))
    return null; try {
    const entry = JSON.parse(line.toString()), extracted = decodeClaudeText([entry], 128 * 1024).find(message => message.role === 'user' || message.role === 'assistant');
    if (!extracted)
        return null;
    const reply = extracted.role === 'user' ? conversationQuestionReply(extracted.text) : undefined;
    const itemId=typeof entry.uuid==='string'?entry.uuid:undefined;
    const turnId=extracted.role==='user'?itemId:typeof entry.parentUuid==='string'?entry.parentUuid:undefined;
    return { message: reply ? { ...extracted, text: reply.text } : extracted, recordType: 'native_message', questionReplies: reply?.answers, imagePaths: [], itemId, turnId };
}
catch {
    return null;
} }
