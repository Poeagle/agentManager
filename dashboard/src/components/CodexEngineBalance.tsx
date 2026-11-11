import {useState} from 'react';
import {useQuery,useQueries} from '@tanstack/react-query';
import {fetchJSON,type CodexEngineBalance as Balance} from '../lib/api';
import {Dialog} from './Dialog';
import {TableFrame} from './table/DataTable';
import {CodexAccountInsights} from './CodexAccountInsights';
import './CodexAccountInsights.css';

const errors:Record<string,string>={missing_key:'未配置 API Key',unauthorized:'API Key 无效或没有余额查询权限',unsupported:'该 Provider 未声明余额接口',invalid_response:'余额接口响应无法识别',timeout:'余额查询超时',network:'余额服务连接失败',too_large:'余额接口响应过大',auth_unknown:'认证方式尚未确认'};
export const balanceError=(error:string)=>errors[error]||'余额暂不可用';
const money=(amount:number|undefined|null,currency:string|undefined)=>amount==null?'未提供':`${currency==='USD'?'$':currency==='CNY'?'¥':`${currency||''} `}${amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4})}`;
export function useEngineBalance(id:string,enabled=true){return useQuery({queryKey:['codex-engine-balance',id],queryFn:()=>fetchJSON<Balance>('/codex/environments/'+encodeURIComponent(id)+'/balance'),enabled,retry:false,staleTime:300000,refetchInterval:300000});}
export function BalanceSummary({id}:{id:string}){
 const balance=useEngineBalance(id),data=balance.data;
 return <span>{balance.isPending?'读取中…':balance.isError?'读取失败':data?.amount!==undefined?`${money(data.amount,data.currency)}${data.status==='stale'?' · 已过期':''}`:errors[data?.error||'']||'暂不可用'}</span>;
}
function ApiTokenHistory({id}:{id:string}){
 const query=useQuery({queryKey:['codex-insights',id],queryFn:()=>fetchJSON<{usage:{initialized?:boolean;partial:boolean;error?:string|null;rows:Array<{date:string;project_name:string;cwd:string;tokens:Record<string,number|null>}>}}>('/codex/environments/'+encodeURIComponent(id)+'/insights'),retry:false,staleTime:300000});
 if(query.isPending)return <p>正在读取历史 Token…</p>;
 if(query.isError)return <p role="status">历史 Token 读取失败。</p>;
 const rows=query.data?.usage.rows||[];
 return <section className="ci-section" aria-label="历史 Token"><h4>历史 Token</h4>{query.data?.usage.partial&&<p className="ci-notice">{query.data.usage.error||'历史统计可能不完整。'}</p>}{rows.length?<TableFrame label="API 历史 Token" className="ci-table-scroll" tableClassName="ci-table" style={{minWidth:1000}} header={<><th>日期</th><th>项目</th><th>工作目录</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th></>}>{rows.slice(0,100).map((row,i)=><tr key={`${row.date}-${row.cwd}-${i}`}><td>{row.date}</td><td>{row.project_name}</td><td title={row.cwd} style={{maxWidth:280,overflow:'hidden',textOverflow:'ellipsis'}}>{row.cwd}</td>{['input_tokens','output_tokens','total_tokens'].map(field=><td key={field}>{row.tokens[field]?.toLocaleString()??'未提供'}</td>)}</tr>)}</TableFrame>:<p>尚无历史 Token 数据。</p>}{rows.length>100&&<p>仅显示最近 100 条记录。</p>}</section>;
}
export function CodexEngineBalanceIndicator({id,name}:{id:string;name:string}){
 const [open,setOpen]=useState(false),query=useEngineBalance(id),data=query.data;
 return <><button type="button" className="workspace-indicator workspace-quota flex h-6 shrink-0 items-center gap-1 rounded border px-1.5" onClick={()=>setOpen(true)} aria-label={`查看 ${name} API 余额详情`}><span>codex · {name}</span><strong>{query.isPending?'读取中':query.isError?'不可用':data?.amount!==undefined?money(data.amount,data.currency):'暂不可用'}</strong>{data?.status==='stale'&&<span>已过期</span>}</button>{open&&<Dialog appearance="manager" title={`${name} API 详情`} size="image" width={1000} onClose={()=>setOpen(false)}><div className="codex-insights"><div className="ci-overview"><section><span className="ci-label">当前上游余额</span><strong className="ci-value">{money(data?.amount,data?.currency)}</strong><p>{data?.status==='stale'?'上次成功数据 · 已过期':data?.status==='available'?'已更新':'暂不可用'}</p>{data?.checkedAt&&<small>读取时间：{new Date(data.checkedAt).toLocaleString()}</small>}</section><section><span className="ci-label">Provider 数量</span><strong className="ci-value">1</strong></section></div><section className="ci-section"><TableFrame label="Provider 钱包与实际扣费" className="ci-table-scroll" tableClassName="ci-table" style={{minWidth:850}} header={<><th>Provider</th><th>钱包余额</th><th>今日实际扣费</th><th>Key 状态</th><th>读取时间</th></>}><tr><td>{name}</td><td>{data?.amount!==undefined?'同上':'未提供'}</td><td>{money(data?.todayActualCost,data?.currency)}</td><td>{data?.error?balanceError(data.error):data?.status==='available'?'有效':'未确认'}</td><td>{data?.checkedAt?'同上':'未提供'}</td></tr></TableFrame></section><ApiTokenHistory id={id}/><p className="ci-footnote">余额与实际扣费来自上游；Token 与 Credits 来自本地历史，Credits 为估算值。</p></div></Dialog>}</>;
}
export function CodexEngineBalanceGroup({group,members}:{group:string;members:Array<{id:string;name:string}>}){
 const [open,setOpen]=useState(false);
 const snapshots=useQueries({queries:members.map(member=>({queryKey:['codex-engine-balance',member.id],queryFn:()=>fetchJSON<Balance>('/codex/environments/'+encodeURIComponent(member.id)+'/balance'),retry:false,staleTime:300000,refetchInterval:300000}))});
 const available=snapshots.map(s=>s.data).filter((v):v is Balance=>v?.amount!==undefined),distinct=new Set(available.map(b=>`${b.currency}:${b.amount}`));
 const incomplete=snapshots.some(s=>s.isError||s.isPending||s.data?.amount===undefined);
 const display=distinct.size>1?'余额不一致':available.length?`${money(available[0].amount,available[0].currency)}${incomplete?' · 部分未确认':''}`:snapshots.some(s=>s.isPending)?'读取中':'暂不可用';
 const stale=snapshots.some(s=>s.data?.status==='stale'),origin=snapshots.find(s=>s.data?.origin)?.data?.origin||members[0].name;
 const allKnown=available.length===members.length,sharedAmount=allKnown&&distinct.size===1;
 const checked=snapshots.map(s=>s.data?.checkedAt),sharedTime=checked.length>0&&checked.every(t=>!!t&&t===checked[0])?checked[0]:null;
 const overview=<><div className="ci-overview"><section><span className="ci-label">当前上游余额</span><strong className="ci-value">{display}</strong>{stale&&<p>部分余额为已过期数据</p>}{sharedTime&&<small>读取时间：{new Date(sharedTime).toLocaleString()}</small>}</section><section><span className="ci-label">Provider 数量</span><strong className="ci-value">{members.length}</strong></section></div><section className="ci-section"><h4>各 Provider 钱包与实际扣费</h4><TableFrame label="Provider 钱包与实际扣费" className="ci-table-scroll" tableClassName="ci-table" style={{minWidth:850}} header={<><th>Provider</th><th>钱包余额</th><th>今日实际扣费</th><th>Key 状态</th><th>读取时间</th></>}>{members.map((member,i)=>{const data=snapshots[i].data;return <tr key={member.id}><td>{member.name}</td><td>{sharedAmount?'同上':money(data?.amount,data?.currency)}{data?.status==='stale'?' · 已过期':''}</td><td>{money(data?.todayActualCost,data?.currency)}</td><td>{data?.error?balanceError(data.error):data?.status==='available'?'有效':'未确认'}</td><td>{sharedTime?'同上':data?.checkedAt?new Date(data.checkedAt).toLocaleString():'未提供'}</td></tr>;})}</TableFrame></section></>;
 return <><button type="button" className="workspace-indicator workspace-quota flex h-6 shrink-0 items-center gap-1 rounded border px-1.5" aria-label={`查看 ${origin} 上游余额详情`} onClick={()=>setOpen(true)}><span>codex · {origin}{origin!==members[0].name?` · ${members[0].name}`:''}</span><strong>{display}</strong>{stale&&<span>已过期</span>}</button>{open&&<CodexAccountInsights id={members[0].id} name={members[0].name} groupId={group} apiOverview={overview} onClose={()=>setOpen(false)}/>}</>;
}
