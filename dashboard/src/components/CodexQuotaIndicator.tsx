/** Backwards-compatible UI entry; the application uses provider capabilities. */
import {AgentQuotaIndicator} from './AgentQuotaIndicator';
import {sessionAgent} from '../lib/agents';
import {api} from '../lib/api';
export function CodexQuotaIndicator(){return <AgentQuotaIndicator agent={sessionAgent({cli_type:'codex'})} read={api.codexQuota.read} queryKey={['codex-weekly-quota','global']}/>;}
