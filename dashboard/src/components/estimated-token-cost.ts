import type { ConversationCostEstimate } from '../lib/api';
import { creditsLabel } from '../lib/session-metadata';

const credits = new Intl.NumberFormat('en', {maximumFractionDigits:3});
const money = new Intl.NumberFormat('en', {maximumFractionDigits:6});

export function formatEstimatedTokenCost(amount:number|null|undefined,unit:string,partial:boolean){
 if(amount==null||!Number.isFinite(amount)||amount<0)return '—';
 const isCredits=unit==='credits';
 const prefix=isCredits?'':unit==='CNY'?'¥':unit==='USD'?'$':`${unit} `;
 const threshold=isCredits?0.001:0.000001;
 const value=amount>0&&amount<threshold?`<${prefix}${threshold}`:`${prefix}${(isCredits?credits:money).format(amount)}`;
 return value+(partial?'*':'');
}

export function conversationCostHeading(cost: ConversationCostEstimate | null | undefined, billingMode?: 'api' | 'account' | null) {
  if (cost) return cost.unit === 'credits' ? '预估积分' : '预估金额';
  if (billingMode === 'api') return '预估金额';
  if (billingMode === 'account') return '预估积分';
  return '预估费用';
}

export function formatConversationCost(cost: ConversationCostEstimate, showCreditsUnit = false) {
  if (cost.unit !== 'credits') return formatEstimatedTokenCost(cost.amount, cost.unit, !cost.complete);
  return creditsLabel(cost) + (showCreditsUnit ? ' Credits' : '');
}
