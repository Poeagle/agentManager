import { isRecord, contentText, cleanText } from '../history-text.js';
import { limitPromptContext, type PromptContextTurn } from '../../prompt-context.js';
const isCodexContinuation = (text: string) => /^<codex_internal_context\b[^>]*>[\s\S]*<\/codex_internal_context>$/.test(text);
/** Codex exposes the exact human prompt and exact final answer as turn events. */
export function extractCodexPromptContext(entries: Iterable<unknown>, rounds: number): PromptContextTurn[] {
    const turns: PromptContextTurn[] = [];
    let user = '';
    let lastHuman = '';
    let finalAnswer = '';
    const commit = () => {
        if (user && finalAnswer)
            turns.push({ user, assistant: finalAnswer });
        user = '';
        finalAnswer = '';
    };
    for (const value of entries) {
        if (!isRecord(value) || !isRecord(value.payload))
            continue;
        const payload = value.payload;
        if ((value.type === 'event_msg' && payload.type === 'user_message')
            || (value.type === 'response_item' && payload.type === 'message' && payload.role === 'user')) {
            const text = value.type === 'event_msg' ? cleanText(payload.message) : contentText(payload.content, 'input_text');
            if (!text)
                continue;
            if (/^<environment_context>[\s\S]*<\/environment_context>$/.test(text))
                continue;
            if (isCodexContinuation(text)) {
                if (!user)
                    user = lastHuman;
                continue;
            }
            // Some releases record the same prompt in both event and response forms.
            if (text === user && !finalAnswer)
                continue;
            // A new human message means any preceding turn without a final answer was
            // interrupted; it must not leak commentary into enhancement context.
            commit();
            user = text;
            lastHuman = text;
            continue;
        }
        if (value.type === 'response_item' && payload.type === 'message'
            && payload.role === 'assistant' && payload.phase === 'final_answer' && user) {
            const text = contentText(payload.content, 'output_text');
            if (text)
                finalAnswer = text;
            continue;
        }
        if (value.type === 'event_msg' && payload.type === 'task_complete' && user) {
            const exactFinal = cleanText(payload.last_agent_message);
            if (exactFinal)
                finalAnswer = exactFinal;
            commit();
        }
    }
    // Newer Codex logs tag final_answer before the task_complete event is flushed.
    commit();
    return limitPromptContext(turns, rounds);
}
