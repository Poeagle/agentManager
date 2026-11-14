import {useState,type ReactNode} from 'react';
import {Dialog} from './Dialog';

/** Compact conversation entry with a centered, scrollable detail view. */
type Props={title:string;summary:ReactNode;children:ReactNode;actions?:ReactNode;active?:boolean};
export function ConversationDialogCard(props:Props) {
  return <DialogCardState key={props.active===false?'inactive':'active'} {...props}/>;
}
function DialogCardState({title,summary,children,actions,active=true}:Props) {
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" className="conversation-card conversation-card-trigger" aria-haspopup="dialog" onClick={()=>setOpen(true)}>{summary}</button>
    {open&&active&&<Dialog title={title} size="image" width={1120} onClose={()=>setOpen(false)} actions={actions}>{children}</Dialog>}
  </>;
}
