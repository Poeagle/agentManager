import { getDb } from '../db/index.js';
import { nativeConversationId } from './session-identity.js';
import { agentForSession } from './agents/index.js';
import { factId } from './agents/session-fact-values.js';
import type { SessionMetadata } from './agents/session-facts.js';
import type { AgentCostEstimate, AgentSession } from './agents/types.js';
import { broadcastEphemeral } from './event-store.js';

interface TabUsage {
  total_tokens: number | null;
  costs: AgentCostEstimate[];
  complete: boolean;
}

type Tab = AgentSession & {id: string};

/** Keep a closed binding's native usage address independently of its transcript. */
export function retainTabUsage(tab: Tab) {
  const db = getDb(), native = nativeConversationId(tab);
  const adapter = agentForSession(tab);
  const source = native && adapter.statistics.facts ? factId(adapter.descriptor.id, tab.agent_environment_id || 'native', native) : '';
  db.prepare(`INSERT INTO session_tab_usage_sources VALUES (?,?,?,?,?)
    ON CONFLICT(tab_id,source) DO UPDATE SET
      parent_tab_id=excluded.parent_tab_id, project_id=excluded.project_id, owner_id=excluded.owner_id`)
    .run(tab.id, source, tab.parent_session_id ?? null, tab.project_id ?? null, tab.created_by_user_id ?? null);
}

export function retainDeletedChildUsage(tab: Tab) {
  if (tab.parent_session_id) retainTabUsage(tab);
  else getDb().prepare('DELETE FROM session_tab_usage_sources WHERE tab_id=?').run(tab.id);
}

const nativeIdSql = 'COALESCE(native_session_id,codex_session_id,claude_session_id)';
const agentIdSql = "COALESCE(agent_id,cli_type,'claude')";
const environmentSql = "COALESCE(agent_environment_id,'native')";

export function readTabUsage(tab: Tab): TabUsage | null {
  const db = getDb();
  const sources = db.prepare(`
    WITH RECURSIVE tabs(id) AS (
      VALUES (@id)
      UNION
      SELECT s.id FROM sessions s JOIN tabs t ON s.parent_session_id=t.id
        WHERE s.project_id IS @project AND s.created_by_user_id IS @owner
      UNION
      SELECT s.tab_id FROM session_tab_usage_sources s JOIN tabs t ON s.parent_tab_id=t.id
        WHERE s.project_id IS @project AND s.owner_id IS @owner
    ), sources(source) AS (
      SELECT h.source FROM session_tab_usage_sources h JOIN tabs t ON h.tab_id=t.id
        WHERE h.project_id IS @project AND h.owner_id IS @owner AND h.source<>''
      UNION
      SELECT n.source FROM tabs t JOIN sessions s ON s.id=t.id
        JOIN session_statistics_sources n ON n.agent=${agentIdSql} AND n.environment=${environmentSql} AND n.native_id=${nativeIdSql}
    )
    SELECT a.source,a.summary,EXISTS (
      SELECT 1 FROM session_statistics_requests r WHERE r.source=a.source AND json_extract(r.fact,'$.inherited')=1
    ) AS inherited
    FROM sources s LEFT JOIN session_statistics_sources a ON a.source=s.source
  `).all({id:tab.id, project:tab.project_id ?? null, owner:tab.created_by_user_id ?? null}) as
    Array<{source:string|null; summary:string|null; inherited:number}>;
  let tokens:number|null = null, complete = true;
  const costs = new Map<string,AgentCostEstimate>();
  const add = (count:number|null|undefined, cost:AgentCostEstimate|null|undefined) => {
    if (count != null) tokens = (tokens ?? 0) + count;
    if (cost?.amount == null) return;
    const key = JSON.stringify([cost.unit,cost.basis ?? null]);
    const previous = costs.get(key);
    costs.set(key,{unit:cost.unit,basis:cost.basis,amount:(previous?.amount ?? 0)+cost.amount,
      complete:cost.complete && (previous?.complete ?? true)});
  };
  for (const row of sources) {
    if (!row.summary || !row.source) {complete = false; continue;}
    const summary = JSON.parse(row.summary) as SessionMetadata, totals = summary.totals;
    if (summary.status !== 'complete') complete = false;
    if (!row.inherited) {
      if (totals?.requests && (totals.tokens?.total_tokens == null || totals.cost?.complete !== true)) complete = false;
      add(totals?.tokens?.total_tokens, totals?.cost);
      continue;
    }
    // A fork includes historical receipts for rendering. Only the locally
    // executed requests belong to its new binding's contribution.
    const groups = db.prepare(`
      SELECT SUM(json_extract(fact,'$.tokens.total_tokens')) AS tokens,
        SUM(json_extract(fact,'$.cost.amount')) AS amount, json_extract(fact,'$.cost.unit') AS unit,
        json_extract(fact,'$.cost.basis') AS basis,
        COUNT(*)=COUNT(json_extract(fact,'$.tokens.total_tokens')) AND
        COUNT(*)=SUM(CASE WHEN json_extract(fact,'$.cost.complete')=1 AND json_extract(fact,'$.cost.amount') IS NOT NULL THEN 1 ELSE 0 END) AS complete
      FROM session_statistics_requests WHERE source=? AND json_extract(fact,'$.inherited') IS NOT 1
      GROUP BY unit,basis
    `).all(row.source) as Array<{tokens:number|null; amount:number|null; unit:string|null; basis:string|null; complete:number}>;
    for (const group of groups) {
      if (!group.complete) complete = false;
      add(group.tokens,group.unit ? {unit:group.unit,basis:group.basis ?? undefined,amount:group.amount,complete:!!group.complete} : null);
    }
  }
  if (tokens === null && !costs.size) return null;
  return {total_tokens:tokens,costs:[...costs.values()].sort((a,b)=>a.unit.localeCompare(b.unit)||(a.basis??'').localeCompare(b.basis??'')),complete};
}

/** Invalidate only the affected tab and its ancestors, without polling models. */
export function notifyTabUsage(source: string, agent: string, environment: string, native: string) {
  const db=getDb();
  const tabs = db.prepare(`
    WITH RECURSIVE affected(id, parent_id, project_id, owner_id) AS (
      SELECT id,parent_session_id,project_id,created_by_user_id FROM sessions
        WHERE ${agentIdSql}=? AND ${environmentSql}=? AND ${nativeIdSql}=?
      UNION
      SELECT tab_id,parent_tab_id,project_id,owner_id FROM session_tab_usage_sources WHERE source=?
      UNION
      SELECT s.id,s.parent_session_id,s.project_id,s.created_by_user_id FROM affected a JOIN sessions s ON s.id=a.parent_id
        WHERE s.project_id IS a.project_id AND s.created_by_user_id IS a.owner_id
      UNION
      SELECT h.tab_id,h.parent_tab_id,h.project_id,h.owner_id FROM affected a JOIN session_tab_usage_sources h ON h.tab_id=a.parent_id
        WHERE h.project_id IS a.project_id AND h.owner_id IS a.owner_id
    )
    SELECT DISTINCT s.id,s.project_id FROM affected a JOIN sessions s ON s.id=a.id
    WHERE s.project_id IS a.project_id AND s.created_by_user_id IS a.owner_id
  `).all(agent,environment,native,source) as Array<{id:string;project_id:string|null}>;
  for (const tab of tabs) if (tab.project_id)
    broadcastEphemeral({type:'session.tab-usage',session_id:tab.id,project_id:tab.project_id});
}
