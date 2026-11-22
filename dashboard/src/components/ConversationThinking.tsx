import { Brain, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

export function ConversationThinking({
  agentName,
  text,
  streaming,
}: {
  agentName: string;
  text: string;
  streaming: boolean;
}) {
  const preview = useRef<HTMLSpanElement>(null);
  const body = text.trim().replace(/\r\n?/g, "\n").replace(/\n(?:[^\S\n]*\n)+/g, "\n");
  const line = streaming ? body.slice(body.lastIndexOf("\n") + 1) : body.split("\n", 1)[0];
  const summary = line.replaceAll("**", "").trim();
  const label = streaming ? `${agentName} 正在思考` : `${agentName} 的思考过程`;
  useLayoutEffect(() => {
    const node = preview.current;
    if (node) node.scrollLeft = streaming ? node.scrollWidth : 0;
  }, [streaming, summary]);
  if (!body) return null;

  return (
    <details className="session-chat-thinking-block" data-streaming={streaming}>
      <summary aria-label={label}>
        <Brain size={14} aria-hidden="true" />
        <span>思考</span>
        <span className="session-chat-thinking-preview" ref={preview} aria-hidden="true">
          {summary}
          {streaming && <span className="session-chat-thinking-caret" />}
        </span>
        <ChevronRight className="session-chat-thinking-chevron" size={13} aria-hidden="true" />
      </summary>
      <div className="session-chat-thinking-body">{body}</div>
    </details>
  );
}
