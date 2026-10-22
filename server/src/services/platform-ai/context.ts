import type { ModelMessage } from './model.js';

// Keep a stable prefix between turns. Compact in batches only when the budget
// is exceeded, and never split a user turn's tool calls from their results.
const MAX_CONTEXT_CHARS = 64000;
const COMPACT_TARGET_CHARS = 32000;

export function compactConversation(messages: ModelMessage[]): ModelMessage[] {
  const sizes = messages.map(message => JSON.stringify(message).length);
  let size = sizes.reduce((sum, value) => sum + value, 0);
  if (size <= MAX_CONTEXT_CHARS) return messages;
  const starts = messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
  let start = 0;
  for (const next of starts.slice(1)) {
    while (start < next) size -= sizes[start++];
    if (size <= COMPACT_TARGET_CHARS) break;
  }
  return messages.slice(start);
}

export function completedConversation(messages: ModelMessage[], content: string): ModelMessage[] {
  const last = messages.at(-1);
  const transcript = last?.role === 'assistant' && !last.tool_calls?.length
    ? [...messages.slice(0, -1), {...last, content}]
    : [...messages, {role: 'assistant' as const, content}];
  return compactConversation(transcript);
}
