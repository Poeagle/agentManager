import { isRecord, contentText, textCollector } from '../history-text.js';
export function decodeClaudeText(entries: Iterable<unknown>, limit = 8000) {
    const { messages, append } = textCollector(limit);
    for (const entry of entries) {
        if (!isRecord(entry) || entry.isSidechain === true || entry.isMeta === true || !isRecord(entry.message))
            continue;
        const m = entry.message;
        if (entry.type === 'user' && m.role === 'user') {
            const origin = isRecord(entry.origin) ? entry.origin : null;
            if (!origin || !origin.kind || origin.kind === 'human')
                append('user', 'user', contentText(m.content, 'text'), entry.timestamp);
        }
        if (entry.type === 'assistant' && m.role === 'assistant')
            append('assistant', m.stop_reason === 'end_turn' ? 'final' : 'commentary', contentText(m.content, 'text'), entry.timestamp);
    }
    return messages;
}
