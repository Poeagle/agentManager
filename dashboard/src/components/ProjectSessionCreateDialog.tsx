import {useCallback,useRef,useState} from 'react';
import {CodexCreateEnvironment} from './CodexCreateEnvironment';
import {ClaudeCreateEnvironment} from './ClaudeCreateEnvironment';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Project, type Session } from '../lib/api';
import { ProjectOpenDialog } from './ProjectOpenDialog';
import { projectOpenModes } from './project-open-modes';
import { conversationClientId } from '../lib/conversation-timeline';

/** One creation flow for the project list and the workspace's + button. */
export function ProjectSessionCreateDialog({ project, onClose, onSessionCreated, title, harnessUrl, onHarnessOpen }: {
  project: Project; onClose: () => void; onSessionCreated: (session: Session) => void; title?: string;
  harnessUrl?: string; onHarnessOpen?: () => void;
}) {
  const client = useQueryClient();
  const [environmentId,setEnvironmentId]=useState<string|undefined>(),[environmentReady,setEnvironmentReady]=useState(false);
  const claudeInitialClientId=useRef(conversationClientId());
  const chooseEnvironment=useCallback((id:string|undefined)=>{
    setEnvironmentId(id);
  },[]);
  const markEnvironmentReady=useCallback((ready:boolean)=>{
    setEnvironmentReady(ready);
  },[]);
  const mutation = useMutation({
    mutationFn: ({ mode, cli }: { mode: 'session' | 'terminal'; cli?: string }) => {
      if (!projectOpenModes(project).some((option) => option.mode === mode && option.cli === cli)) throw new Error('该打开方式未获授权');
      const clientId=mode==='session'&&cli==='claude'?claudeInitialClientId.current:undefined;
      return api.sessions.create({ project_id: project.id, project_path: project.path, mode,
        ...(clientId?{client_id:clientId}:{}),
        ...(mode==='session'&&(cli==='codex'||cli==='claude')&&environmentId?{environment_id:environmentId}:{}),
        ...(mode === 'session' ? { cli_type: cli } : {}),
      });
    },
    onSuccess: ({ session }) => {
      client.setQueryData<{ sessions: Session[] }>(['sessions'], (current) => ({ sessions: [session, ...(current?.sessions ?? []).filter((item) => item.id !== session.id)] }));
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: ['project-sessions', project.id] });
      onSessionCreated(session);
      onClose();
    },
  });
  return <ProjectOpenDialog project={project} harnessUrl={onHarnessOpen ? harnessUrl : undefined} title={title} onClose={onClose} busy={mutation.isPending} error={mutation.error?.message}
    renderOptions={(mode,cli)=>
      mode==='session'&&cli==='codex'
        ? <CodexCreateEnvironment projectId={project.id} onChange={chooseEnvironment} onReady={markEnvironmentReady}/>
        : mode==='session'&&cli==='claude'
          ? <ClaudeCreateEnvironment onChange={chooseEnvironment} onReady={markEnvironmentReady}/>
          : null}
    isChoiceReady={(mode,cli)=>
      mode!=='session'||(cli!=='codex'&&cli!=='claude')||environmentReady}
    onOpen={(mode, cli) => {
      if (mode === 'deepseek-harness') {
        onHarnessOpen?.();
        onClose();
      } else mutation.mutate({ mode, cli });
    }} />;
}
