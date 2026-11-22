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
