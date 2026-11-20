import { useState } from "react";

export function ConversationThinking({
  agentName,
  text,
  streaming,
}: {
  agentName: string;
  text: string;
  streaming: boolean;
}) {
  const [open,setOpen]=useState(false);
  if (streaming)
    return (
      <div
        className="session-chat-thinking-block session-chat-thinking-block-streaming"
        role="status"
        aria-label={`${agentName} 正在思考`}
      >
        <div className="session-chat-thinking-live-heading">
          <span className="session-chat-thinking-spark" aria-hidden="true" />
          <span>{agentName} 正在思考</span>
          <small>实时输出</small>
        </div>
        <div className="session-chat-thinking-live-text">
          {text}
          <span className="session-chat-thinking-caret" aria-hidden="true" />
        </div>
      </div>
    );
  return (
    <details
      className="session-chat-thinking-block"
      open={open}
      onToggle={(event)=>setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="session-chat-thinking-spark" aria-hidden="true" />
        <span>{agentName} 的思考过程</span>
        <small>已完成</small>
      </summary>
      <div>{text}</div>
    </details>
  );
}
