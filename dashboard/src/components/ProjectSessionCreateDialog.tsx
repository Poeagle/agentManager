import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Project, type Session } from '../lib/api';
import { ProjectOpenDialog } from './ProjectOpenDialog';
import { projectOpenModes } from './project-open-modes';

/** One creation flow for the project list and the workspace's + button. */
export function ProjectSessionCreateDialog({ project, onClose, onSessionCreated, title }: {
  project: Project; onClose: () => void; onSessionCreated: (session: Session) => void; title?: string;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ mode, cli }: { mode: 'session' | 'terminal'; cli?: 'claude' | 'codex' }) => {
      if (!projectOpenModes(project).some((option) => option.mode === mode && option.cli === cli)) throw new Error('该打开方式未获授权');
      const prompt = 'Start up and ask me what I want you to do and NOTHING ELSE';
      const instructions = project.session_prompt?.trim();
      return api.sessions.create({ project_id: project.id, project_path: project.path, mode,
        ...(mode === 'session' ? { cli_type: cli, task: instructions ? `${prompt}\n\n---\nAdditional Instructions:\n${instructions}` : prompt } : {}),
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
  return <ProjectOpenDialog project={project} title={title} onClose={onClose} busy={mutation.isPending} error={mutation.error?.message}
    onOpen={(mode, cli) => mutation.mutate({ mode, cli })} />;
}
