import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Bot, Check, Copy, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { api, type AgentApiContract, type AgentApiEndpoint } from '../lib/api';

export function AgentGuideButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors hover:bg-white/10"
        style={{ color: 'var(--text-secondary)' }}
        title="Agent Integration Guide"
      >
        <Bot className="w-4 h-4" />
        <span className="hidden sm:inline">Agent API</span>
      </button>
      {open && <AgentGuideModal onClose={() => setOpen(false)} />}
    </>
  );
}

interface AgentGuideModalProps {
  onClose: () => void;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  task?: string;
  additionalInstructions?: string;
}

interface GuideContext {
  projectId?: string;
  projectName: string;
  projectPath: string;
  task?: string;
  additionalInstructions?: string;
}

export function AgentGuideModal({
  onClose,
  projectId,
  projectName,
  projectPath,
  task,
  additionalInstructions,
}: AgentGuideModalProps) {
  const baseUrl = window.location.origin;
  const [copiedAll, setCopiedAll] = useState(false);
  const context = projectName && projectPath
    ? { projectId, projectName, projectPath, task, additionalInstructions }
    : undefined;
  const { data: contract, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['agent-api-capabilities'],
    queryFn: api.agent.capabilities,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const endpointGroups = useMemo(() => {
    const groups = new Map<string, AgentApiEndpoint[]>();
    for (const endpoint of contract?.endpoints ?? []) {
      const group = groups.get(endpoint.category) ?? [];
      group.push(endpoint);
      groups.set(endpoint.category, group);
    }
    return [...groups.entries()];
  }, [contract]);

  async function copyFullGuide() {
    if (!contract) return;
    await navigator.clipboard.writeText(generateGuide(contract, baseUrl, context));
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 2500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Bot className="w-5 h-5 shrink-0" style={{ color: 'var(--accent)' }} />
            <h2 className="text-lg font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {context ? `Run ${context.projectName} with Agent API` : 'Agent API'}
            </h2>
            {contract && (
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-mono shrink-0"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                v{contract.version} · {contract.updatedAt}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={copyFullGuide}
              disabled={!contract}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
              style={{
                background: copiedAll ? 'var(--success)' : 'var(--bg-tertiary)',
                color: copiedAll ? 'white' : 'var(--text-secondary)',
              }}
              title="Copy the live backend contract as a plain-text agent guide"
            >
              {copiedAll ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedAll ? 'Copied!' : 'Copy All'}
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-white/10" style={{ color: 'var(--text-secondary)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading && <LoadingState />}
          {error && !contract && <ErrorState message={error instanceof Error ? error.message : 'Failed to load Agent API contract'} retry={() => refetch()} loading={isFetching} />}
          {contract && (
            <div className="space-y-7">
              {context && <ProjectContextBanner context={context} />}

              <Section title="Live contract">
                <p>{contract.description}</p>
                <p className="mt-2 text-xs">{contract.scope}</p>
                <div
                  className="mt-3 px-3 py-2 rounded-lg text-xs flex items-center gap-2"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  Loaded from <code>{contract.authentication.capabilitiesEndpoint}</code>; this page contains no separate endpoint list.
                </div>
              </Section>

              <Section title="Authentication">
                <p>{contract.authentication.login}</p>
                <p className="mt-1">{contract.authentication.usage}</p>
                <CodeBlock text={loginCurl(contract, baseUrl)} />
                <p className="text-xs">{contract.authentication.security}</p>
              </Section>

              <Section title="Authorization boundaries">
                <DefinitionList values={contract.authorization} />
              </Section>

              {context && (
                <Section title="Create this project session">
                  <CodeBlock text={contextSessionCurl(baseUrl, context)} />
                </Section>
              )}

              <Section title="Quick start">
                <ol className="list-decimal pl-5 space-y-1.5">
                  {contract.quickstart.map((step) => <li key={step}>{step.replace(/^\d+\.\s*/, '')}</li>)}
                </ol>
              </Section>

              <Section title="Critical rules">
                <ul className="space-y-1.5">
                  {contract.critical.map((rule) => <Rule key={rule}>{rule}</Rule>)}
                </ul>
              </Section>

              <Section title={`Integration endpoints (${contract.endpoints.length})`}>
                <div className="space-y-5">
                  {endpointGroups.map(([category, endpoints]) => (
                    <div key={category}>
                      <h4 className="text-xs uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                        {category}
                      </h4>
                      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                        {endpoints.map((endpoint) => <EndpointDetails key={`${endpoint.method}-${endpoint.path}`} endpoint={endpoint} />)}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Section title="Session states">
                  <DefinitionList values={contract.stateMachine.states} />
                  <div className="mt-3 space-y-1.5">
                    {contract.stateMachine.transitions.map((transition) => (
                      <div key={`${transition.from}-${transition.to}-${transition.trigger}`} className="text-xs">
                        <code>{transition.from}</code> → <code>{transition.to}</code>: {transition.trigger}
                      </div>
                    ))}
                  </div>
                </Section>
                <Section title="Prompt types">
                  <DefinitionList values={contract.promptTypes} />
                </Section>
              </div>

              <Section title="Operational tips">
                <ul className="space-y-1.5">
                  {contract.tips.map((tip) => <Rule key={tip}>{tip}</Rule>)}
                </ul>
              </Section>

              <Section title="Operational guidance">
                <JsonDetails title="Current backend guidance" value={contract.operationalGuidance} />
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="h-64 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-secondary)' }}>
      <Loader2 className="w-5 h-5 animate-spin" />
      <span className="text-sm">Loading the live backend contract…</span>
    </div>
  );
}

function ErrorState({ message, retry, loading }: { message: string; retry: () => void; loading: boolean }) {
  return (
    <div className="h-64 flex flex-col items-center justify-center gap-3 text-center">
      <AlertCircle className="w-6 h-6" style={{ color: 'var(--error)' }} />
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>The current Agent API contract could not be loaded.</p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{message}</p>
      </div>
      <button
        onClick={retry}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        Retry
      </button>
    </div>
  );
}

function ProjectContextBanner({ context }: { context: GuideContext }) {
  return (
    <div
      className="rounded-lg border p-4 space-y-2"
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--accent)' }}
    >
      <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--accent)' }}>
        <Play className="w-4 h-4" />
        Ready to run
      </div>
      <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
        <div><strong style={{ color: 'var(--text-primary)' }}>Project:</strong> {context.projectName}</div>
        {context.projectId && <div><strong style={{ color: 'var(--text-primary)' }}>ID:</strong> <code>{context.projectId}</code></div>}
        <div><strong style={{ color: 'var(--text-primary)' }}>Path:</strong> <code>{context.projectPath}</code></div>
        {context.task && <div><strong style={{ color: 'var(--text-primary)' }}>Task:</strong> {context.task}</div>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      <div className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{children}</div>
    </section>
  );
}

function EndpointDetails({ endpoint }: { endpoint: AgentApiEndpoint }) {
  const hasDetails = endpoint.request || endpoint.response || endpoint.errors || endpoint.incomingMessages || endpoint.outgoingMessages;
  return (
    <details className="group" style={{ borderBottom: '1px solid var(--border)' }}>
      <summary className={`px-3 py-2.5 list-none ${hasDetails ? 'cursor-pointer' : 'cursor-default'}`}>
        <div className="flex items-start gap-3">
          <MethodBadge method={endpoint.method} />
          <div className="min-w-0 flex-1">
            <code className="text-xs break-all" style={{ color: 'var(--text-primary)' }}>{endpoint.path}</code>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{endpoint.description}</p>
          </div>
          {endpoint.public && <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--success)' }}>Public</span>}
        </div>
      </summary>
      {hasDetails && (
        <div className="px-3 pb-3 pl-[5.75rem] space-y-2">
          {endpoint.request && <JsonDetails title="Request" value={endpoint.request} />}
          {endpoint.response && <JsonDetails title="Response" value={endpoint.response} />}
          {endpoint.errors && <JsonDetails title="Errors" value={endpoint.errors} />}
          {endpoint.incomingMessages && <JsonDetails title="WebSocket input" value={endpoint.incomingMessages} />}
          {endpoint.outgoingMessages && <JsonDetails title="WebSocket output" value={endpoint.outgoingMessages} />}
        </div>
      )}
    </details>
  );
}

function MethodBadge({ method }: { method: AgentApiEndpoint['method'] }) {
  const color = method === 'GET' ? '#60a5fa'
    : method === 'POST' ? '#34d399'
      : method === 'DELETE' ? '#f87171'
        : method === 'WS' ? '#a78bfa'
          : '#fbbf24';
  return (
    <span className="w-16 shrink-0 text-[11px] font-mono font-bold" style={{ color }}>{method}</span>
  );
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-secondary)' }}>{title}</div>
      <pre
        className="text-[11px] leading-relaxed p-2 rounded-md overflow-x-auto"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function DefinitionList({ values }: { values: Record<string, string> }) {
  return (
    <dl className="space-y-2">
      {Object.entries(values).map(([name, description]) => (
        <div key={name}>
          <dt><code style={{ color: 'var(--text-primary)' }}>{name}</code></dt>
          <dd className="text-xs mt-0.5">{description}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="relative group mt-2 mb-2">
      <pre className="text-xs font-mono p-3 pr-10 rounded-lg overflow-x-auto" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        {text}
      </pre>
      <button onClick={copy} className="absolute top-2 right-2 p-1 rounded opacity-60 group-hover:opacity-100" style={{ background: 'var(--bg-tertiary)' }}>
        {copied ? <Check className="w-3 h-3" style={{ color: 'var(--success)' }} /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-sm flex gap-2">
      <span style={{ color: 'var(--accent)' }}>•</span>
      <span>{children}</span>
    </li>
  );
}

function absoluteUrl(baseUrl: string, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalized}`;
}

function loginCurl(contract: AgentApiContract, baseUrl: string): string {
  return `umask 077
curl --fail --silent --show-error \\
  -c ./agentmanager.cookies \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' \\
  ${absoluteUrl(baseUrl, contract.authentication.loginEndpoint)}`;
}

function contextSessionCurl(baseUrl: string, context: GuideContext): string {
  const effectiveTask = context.task?.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE';
  const prompt = context.additionalInstructions
    ? `${effectiveTask}\n\n---\nAdditional Instructions:\n${context.additionalInstructions}`
    : effectiveTask;
  const body = {
    ...(context.projectId ? { project_id: context.projectId } : {}),
    project_path: context.projectPath,
    task: prompt,
    mode: 'session',
    cli_type: 'claude',
  };
  return `curl --fail --silent --show-error \\
  -b ./agentmanager.cookies \\
  -H 'Content-Type: application/json' \\
  -d '${JSON.stringify(body)}' \\
  ${baseUrl}/api/sessions`;
}

export function generateGuide(contract: AgentApiContract, baseUrl: string, context?: GuideContext): string {
  const lines = [
    `# ${contract.name}`,
    '',
    `Contract version: ${contract.version}`,
    `Updated: ${contract.updatedAt}`,
    `Base URL: ${baseUrl}`,
    '',
    '## Scope',
    contract.description,
    contract.scope,
  ];

  if (context) {
    lines.push(
      '',
      '## Project context',
      `Project: ${context.projectName}`,
      `Project ID: ${context.projectId || 'Look up with GET /api/projects'}`,
      `Path: ${context.projectPath}`,
      `Task: ${context.task?.trim() || 'Start up and ask me what I want you to do and NOTHING ELSE'}`,
      '',
      '## Create this project session',
      contextSessionCurl(baseUrl, context),
    );
  }

  lines.push(
    '',
    '## Authentication',
    contract.authentication.login,
    contract.authentication.usage,
    contract.authentication.security,
    `Authentication errors: ${JSON.stringify(contract.authentication.errors)}`,
    '',
    loginCurl(contract, baseUrl),
    '',
    '## Quick start',
    ...contract.quickstart,
    '',
    '## Authorization',
    ...Object.entries(contract.authorization).map(([name, value]) => `- ${name}: ${value}`),
    '',
    '## Critical rules',
    ...contract.critical.map((rule) => `- ${rule}`),
    '',
    `## Integration endpoints (${contract.endpoints.length})`,
  );

  let category = '';
  for (const endpoint of contract.endpoints) {
    if (endpoint.category !== category) {
      category = endpoint.category;
      lines.push('', `### ${category}`);
    }
    lines.push(`${endpoint.method.padEnd(6)} ${endpoint.path} — ${endpoint.description}`);
    if (endpoint.request) lines.push(`Request: ${JSON.stringify(endpoint.request)}`);
    if (endpoint.response) lines.push(`Response: ${JSON.stringify(endpoint.response)}`);
    if (endpoint.errors) lines.push(`Errors: ${JSON.stringify(endpoint.errors)}`);
    if (endpoint.incomingMessages) lines.push(`WebSocket input: ${JSON.stringify(endpoint.incomingMessages)}`);
    if (endpoint.outgoingMessages) lines.push(`WebSocket output: ${JSON.stringify(endpoint.outgoingMessages)}`);
  }

  lines.push(
    '',
    '## Session states',
    ...Object.entries(contract.stateMachine.states).map(([name, value]) => `- ${name}: ${value}`),
    ...contract.stateMachine.transitions.map((transition) => `- ${transition.from} -> ${transition.to}: ${transition.trigger}`),
    '',
    '## Prompt types',
    ...Object.entries(contract.promptTypes).map(([name, value]) => `- ${name}: ${value}`),
    '',
    '## Operational tips',
    ...contract.tips.map((tip) => `- ${tip}`),
    '',
    '## Operational guidance',
    JSON.stringify(contract.operationalGuidance, null, 2),
  );

  return lines.join('\n');
}
