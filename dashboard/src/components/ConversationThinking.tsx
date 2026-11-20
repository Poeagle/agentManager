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
  return (
    <details
      className="session-chat-thinking-block"
      open={open}
      onToggle={(event)=>setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="session-chat-thinking-spark" aria-hidden="true" />
        <span>
          {streaming
            ? `${agentName} 正在思考`
            : `${agentName} 的思考过程`}
        </span>
        <small>{streaming ? "实时输出" : "已完成"}</small>
      </summary>
      <div>{text}</div>
    </details>
  );
}
