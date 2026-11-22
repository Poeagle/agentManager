import type { ConversationCostEstimate } from '../lib/api';
const money = new Intl.NumberFormat('en', {minimumFractionDigits:2,maximumFractionDigits:2});
const CREDITS_PER_USD=25;

export function formatEstimatedTokenCost(amount:number|null|undefined,unit:string,partial:boolean){
 if(amount==null||!Number.isFinite(amount)||amount<0)return '—';
 const isCredits=unit==='credits';
 const currency=isCredits?'USD':unit;
 const prefix=currency==='CNY'?'¥':currency==='USD'?'$':`${currency} `;
 const valueInCurrency=isCredits?amount/CREDITS_PER_USD:amount;
 const value=valueInCurrency>0&&valueInCurrency<0.01?`<${prefix}0.01`:`${prefix}${money.format(valueInCurrency)}`;
 return value+(partial?'*':'');
}

export function conversationCostHeading(cost: ConversationCostEstimate | null | undefined, billingMode?: 'api' | 'account' | null) {
  if (cost) return '预估金额';
  if (billingMode === 'api') return '预估金额';
  if (billingMode === 'account') return '预估金额';
  return '预估费用';
}

export function formatConversationCost(cost: ConversationCostEstimate) {
  return formatEstimatedTokenCost(cost.amount, cost.unit, !cost.complete);
}
