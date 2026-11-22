import { tokenFields } from './conversation-usage.js';
import type { AgentCostEstimate, AgentStatisticsInterval } from './agents/types.js';
import type { NativeRequestFact, SessionCoverageReason, SessionTokens, SessionUsageTotals } from './agents/session-facts.js';

interface CostCounter {
  amount: number;
  priced: number;
  incomplete: number;
  applicable: number;
  input: number;
  cache: number;
  output: number;
  reasoning: number;
  missingReasoning: number;
  rateDate?: string;
  unit?: string;
  basis?: string;
  incompatible?: number;
  missingBreakdown?: number;
}

export interface StatisticsCounter {
  values: number[];
  known: number[];
  requests: number;
  tools: number;
  rounds: number;
  gaps: Partial<Record<SessionCoverageReason, number>>;
  cost: CostCounter;
}

export const emptyCounter = (): StatisticsCounter => ({
  values: tokenFields.map(() => 0), known: tokenFields.map(() => 0),
  requests: 0, tools: 0, rounds: 0, gaps: {},
  cost: {amount: 0, priced: 0, incomplete: 0, applicable: 0, input: 0, cache: 0, output: 0, reasoning: 0, missingReasoning: 0},
});

export function copyCounter(source: StatisticsCounter): StatisticsCounter {
  return {...source, values: [...source.values], known: [...source.known], gaps: {...source.gaps}, cost: {...source.cost}};
}

export function countRequest(total: StatisticsCounter, request: NativeRequestFact, tools: number) {
  total.requests++;
  total.tools += tools;
  total.rounds += Number(tools > 0);
  for (const [index, key] of tokenFields.entries()) {
    const token = request.tokens?.[key];
    if (token == null) continue;
    total.values[index] += token;
    total.known[index]++;
  }
  const cost = request.cost;
  if (!cost) return;
  total.cost.applicable++;
  if (!cost.complete) total.cost.incomplete++;
  if (cost.amount === null) return;
  if(total.cost.unit&&(total.cost.unit!==cost.unit||total.cost.basis!==cost.basis)){
    total.cost.incompatible=(total.cost.incompatible??0)+1;
    return;
  }
  total.cost.unit=cost.unit;
  total.cost.basis=cost.basis;
  total.cost.priced++;
  total.cost.amount += cost.amount;
  total.cost.rateDate = cost.rate_date;
  if (cost.breakdown) {
    total.cost.input += cost.breakdown.input;
    total.cost.cache += cost.breakdown.cache;
    total.cost.output += cost.breakdown.output;
    total.cost.reasoning += cost.breakdown.reasoning ?? 0;
  }
  if (cost.breakdown?.reasoning == null) total.cost.missingReasoning++;
  if (!cost.breakdown) total.cost.missingBreakdown=(total.cost.missingBreakdown??0)+1;
}

export function counterReasons(end: StatisticsCounter, start = emptyCounter()): SessionCoverageReason[] {
  return (Object.keys(end.gaps) as SessionCoverageReason[]).filter(reason => end.gaps[reason]! > (start.gaps[reason] ?? 0));
}

export function usageTotals(end: StatisticsCounter, start = emptyCounter(), partial = false): SessionUsageTotals {
  const requests = end.requests - start.requests;
  const tokens = requests ? Object.fromEntries(tokenFields.map((field, index) => {
    const sum = end.values[index] - start.values[index];
    return [field, end.known[index] > start.known[index] && Number.isSafeInteger(sum) ? sum : null];
  })) as SessionTokens : null;
  const priced = (end.cost.incompatible??0)===(start.cost.incompatible??0)?end.cost.priced-start.cost.priced:0;
  const cost: AgentCostEstimate | null = end.cost.applicable === start.cost.applicable ? null : {
    unit: end.cost.unit??'credits',
    basis: end.cost.basis,
    rate_date: end.cost.rateDate,
    amount: priced ? end.cost.amount - start.cost.amount : null,
    complete: !partial && priced === requests && end.cost.incomplete === start.cost.incomplete,
    ...(priced&&(end.cost.missingBreakdown??0)===(start.cost.missingBreakdown??0) ? {breakdown: {
      input: end.cost.input - start.cost.input, cache: end.cost.cache - start.cost.cache,
      output: end.cost.output - start.cost.output,
      reasoning: end.cost.missingReasoning === start.cost.missingReasoning ? end.cost.reasoning - start.cost.reasoning : null,
    }} : {}),
  };
  return {tokens, requests, tool_calls: end.tools - start.tools, tool_rounds: end.rounds - start.rounds, cost};
}

export function recordedInterval(
  end: StatisticsCounter, start: StatisticsCounter | undefined,
  sharedMessages = 1, extra: SessionCoverageReason[] = [], pending = false,
): AgentStatisticsInterval {
  const reasons = [...new Set([...extra, ...counterReasons(end, start)])];
  const complete = !pending && reasons.length === 0;
  return {
    ...usageTotals(end, start, !complete),
    complete, shared_messages: sharedMessages, coverage: pending ? 'pending' : complete ? 'complete' : 'partial', reasons,
  };
}
