export const CODEX_REASONING_LIMIT = 8 * 1024;
export const CODEX_REASONING_PARTS = 16;

export function codexReasoningParts(value: unknown, recordType?: 'summary_text' | 'reasoning_text'): string[] {
  if (!Array.isArray(value)) return [];
  let remaining = CODEX_REASONING_LIMIT;
  return value.slice(0, CODEX_REASONING_PARTS).map(part => {
    const text = recordType ? (part?.type === recordType ? part.text : undefined) : part;
    const bounded = typeof text === 'string' ? text.slice(0, remaining) : '';
    remaining -= bounded.length;
    return bounded;
  });
}

export function codexReasoningText(summary: string[], content: string[]): string {
  const visible = summary.some(part => part?.trim()) ? summary : content;
  return visible.filter(part => part?.trim()).join('\n').slice(0, CODEX_REASONING_LIMIT);
}
