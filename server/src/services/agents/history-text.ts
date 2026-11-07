import { createHash } from 'crypto';
import type { AgentTextMessage } from './types.js';
export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function cleanText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
export function contentText(content: unknown, blockType: 'text' | 'input_text' | 'output_text'): string {
    if (typeof content === 'string')
        return content.trim();
    if (!Array.isArray(content))
        return '';
    return content
        .filter(isRecord)
        .filter((block) => block.type === blockType && typeof block.text === 'string')
        .map((block) => (block.text as string).trim())
        .filter(Boolean)
        .join('\n')
        .trim();
}
export function clipped(text: string, limit = 8000): string {
    if (text.length <= limit)
        return text;
    const marker = '\n…[上下文已截断]…\n';
    const remaining = Math.max(0, limit - marker.length);
    const head = Math.ceil(remaining * 0.6);
    return `${text.slice(0, head)}${marker}${text.slice(-(remaining - head))}`;
}
export function textCollector(messageLimit: number) {
    const messages: AgentTextMessage[] = [];
    let taskReference: string | null = null;
    const append = (role: AgentTextMessage['role'], phase: AgentTextMessage['phase'], text: string, timestamp: unknown) => {
        if (!text || /^<environment_context>[\s\S]*<\/environment_context>$/.test(text))
            return;
        const last = messages.at(-1);
        if (last?.role === role && last.text === text) {
            if (phase === 'final' || last.phase === 'unknown')
                last.phase = phase;
            return;
        }
        if (role === 'user')
            taskReference = /\[Platform task reference: ([A-Za-z0-9_-]+)\]/.exec(text)?.[1] || 'native:' + createHash('sha256').update(JSON.stringify([timestamp || null, text])).digest('hex').slice(0, 40);
        messages.push({ role, phase, text: clipped(text, messageLimit), timestamp: typeof timestamp === 'string' ? timestamp : null, task_reference: taskReference });
    };
    return { messages, append };
}
