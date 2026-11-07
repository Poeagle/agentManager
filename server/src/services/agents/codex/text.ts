import { isRecord, contentText, cleanText, textCollector } from '../history-text.js';
/** Codex persists local images between generated input_text wrappers. Their
 * paths are already represented by attachments; they are not a second prompt. */
export function codexUserText(content: unknown): string {
    if (!Array.isArray(content))
        return contentText(content, 'input_text');
    return contentText(content.filter((block, index) => {
        if (!isRecord(block) || block.type !== 'input_text' || typeof block.text !== 'string')
            return true;
        const text = block.text.trim();
        if (/^<image name=\[Image #\d+\] path=[\s\S]*>$/.test(text) && isRecord(content[index + 1]) && content[index + 1].type === 'input_image')
            return false;
        if (text === '</image>' && isRecord(content[index - 1]) && content[index - 1].type === 'input_image')
            return false;
        return true;
    }), 'input_text');
}
export function decodeCodexText(entries: Iterable<unknown>, limit = 8000) {
    const { messages, append: collect } = textCollector(limit);
    const phase = (value: unknown): 'unknown' | 'commentary' | 'final' => value === 'final_answer' || value === 'final'
        ? 'final'
        : value === 'commentary' ? 'commentary' : 'unknown';
    const itemText = (content: unknown) => Array.isArray(content)
        ? content.filter(isRecord)
            .filter(block => ['Text', 'output_text', 'text'].includes(String(block.type)) && typeof block.text === 'string')
            .map(block => (block.text as string).trim())
            .filter(Boolean).join('\n').trim()
        : '';
    const append = (role: 'user' | 'assistant', phase: 'user' | 'unknown' | 'commentary' | 'final', text: string, timestamp: unknown) => { if (role === 'user' && /^<codex_internal_context\b[^>]*>[\s\S]*<\/codex_internal_context>$/.test(text))
        return; collect(role, phase, text, timestamp); };
    for (const entry of entries) {
        if (!isRecord(entry) || !isRecord(entry.payload))
            continue;
        const p = entry.payload;
        if (entry.type === 'response_item' && p.type === 'message') {
            if (p.role === 'user')
                append('user', 'user', codexUserText(p.content), entry.timestamp);
            if (p.role === 'assistant')
                append('assistant', phase(p.phase), contentText(p.content, 'output_text'), entry.timestamp);
        }
        else if (entry.type === 'event_msg') {
            if (p.type === 'user_message')
                append('user', 'user', cleanText(p.message), entry.timestamp);
            if (p.type === 'agent_message')
                append('assistant', phase(p.phase), cleanText(p.message), entry.timestamp);
            if (p.type === 'item_completed' && isRecord(p.item) && p.item.type === 'AgentMessage')
                append('assistant', phase(p.item.phase), itemText(p.item.content), entry.timestamp);
            if (p.type === 'task_complete')
                append('assistant', 'final', cleanText(p.last_agent_message), entry.timestamp);
        }
    }
    return messages;
}
