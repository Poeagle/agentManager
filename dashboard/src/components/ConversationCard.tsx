import type {ReactNode} from 'react';

/** Shared disclosure shell; callers own the meaning and content of the card. */
export function ConversationCard({summary,children,className='',open,status}:{summary:ReactNode;children:ReactNode;className?:string;open?:boolean;status?:string}) {
  return <details className={`conversation-card ${className}`} open={open} data-status={status}>
    <summary>{summary}</summary>
    {children}
  </details>;
}
