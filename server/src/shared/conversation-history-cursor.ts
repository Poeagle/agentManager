/** Claude can persist reasoning before the answer under the same message ID.
 * Keep that suffix eligible for incremental reads until the answer arrives. */
export function conversationHistoryCursor(messages: ReadonlyArray<{
  id: string;
  role: string;
  phase?: string;
  text: string;
  content_blocks?: ReadonlyArray<{type: string}>;
}>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && message.phase === 'commentary' && !message.text.trim() &&
        message.content_blocks?.some(block => block.type === 'thinking')) continue;
    return message.id;
  }
  return undefined;
}
