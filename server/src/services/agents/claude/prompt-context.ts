import { isRecord, contentText } from '../history-text.js';
import { limitPromptContext, type PromptContextTurn } from '../../prompt-context.js';
export function extractClaudePromptContext(entries: Iterable<unknown>, rounds: number): PromptContextTurn[] {
    const turns: PromptContextTurn[] = [];
    let user = '';
    let finalAnswer = '';
    let turnCompleted = false;
    const commit = () => {
        if (user && finalAnswer && turnCompleted)
            turns.push({ user, assistant: finalAnswer });
        user = '';
        finalAnswer = '';
        turnCompleted = false;
    };
    for (const value of entries) {
        if (!isRecord(value) || value.isSidechain === true || value.isMeta === true)
            continue;
        const message = isRecord(value.message) ? value.message : null;
        if (value.type === 'user' && message?.role === 'user') {
            const origin = isRecord(value.origin) ? value.origin : null;
            if (origin && typeof origin.kind === 'string' && origin.kind !== 'human')
                continue;
            const text = contentText(message.content, 'text');
            // Array-valued tool_result records contain no direct text blocks and are
            // ignored; a real next prompt closes the preceding completed turn.
            if (!text)
                continue;
            commit();
            user = text;
            continue;
        }
        if (value.type === 'assistant' && message?.role === 'assistant' && user) {
            const text = contentText(message.content, 'text');
            if (text) {
                finalAnswer = text;
                if (message.stop_reason === 'end_turn')
                    turnCompleted = true;
            }
            continue;
        }
        if (value.type === 'system' && value.subtype === 'turn_duration' && user && finalAnswer) {
            turnCompleted = true;
            commit();
        }
    }
    commit();
    return limitPromptContext(turns, rounds);
}
