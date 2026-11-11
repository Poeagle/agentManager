import {Fragment,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {RefreshCw} from 'lucide-react';
import {api,type ConversationControlsData} from '../lib/api';
import {Dialog} from './Dialog';
import {TableFrame} from './table/DataTable';
import {formatConversationTimestamp} from '../lib/conversation-timing';
import './ConversationContextUsage.css';

const colors:Record<string,string>={system:'#1677ff',tools:'#eb2f96',injections:'#13c2c2',user:'#52c41a',assistant:'#fa8c16',calls:'#722ed1',results:'#faad14',summary:'#8c8c8c',images:'#595959'};
const number=(value:number|null|undefined)=>value==null?'未提供':value.toLocaleString('zh-CN');
export function ConversationContextUsage({sessionId,nativeId,usage,observedAt,model,onClose}:{sessionId:string;nativeId:string;usage:ConversationControlsData['usage'];observedAt:string|null;model:string|null;onClose:()=>void}){
 const force=useRef(false),[expanded,setExpanded]=useState<Record<string,boolean>>({});
 const query=useQuery({queryKey:['conversation-context-breakdown',sessionId,nativeId],queryFn:({signal})=>{const refresh=force.current;force.current=false;return api.agent.contextBreakdown(sessionId,refresh,signal);},staleTime:30000,refetchOnWindowFocus:false,retry:false});
 const data=query.data?.context;
 const recent=data?.usage&&(!usage||!!data.observed_at&&(!observedAt||Date.parse(data.observed_at)>=Date.parse(observedAt)))?{usage:data.usage,time:data.observed_at}:{usage,time:observedAt};
 const used=recent.usage?.last.total_tokens,window=recent.usage?.window;
 const percent=used!=null&&window!=null&&window>0?used/window*100:null;
 const total=data?.categories.reduce((sum,c)=>sum+(c.tokens??0),0)??0;
 const share=(tokens:number|null)=>tokens!=null&&total>0?`${(tokens/total*100).toFixed(1)}%`:'—';
 return <Dialog title="上下文 Token 详情" size="image" width={900} appearance="manager" onClose={onClose} actions={<button type="button" className="context-usage-refresh" disabled={query.isFetching} onClick={()=>{force.current=true;void query.refetch();}}><RefreshCw size={13} className={query.isFetching?'animate-spin':''}/>{query.isFetching?'读取中…':'重新读取'}</button>}>
  <section className="context-usage" aria-label="上下文分类详情">
   <div className="context-usage-summary"><strong>原生上下文 {number(used)} / {number(window)} Token</strong><span>{percent==null?'占用比例未提供':`${percent.toFixed(1)}%`}</span><span>模型 {data?.model||model||'未提供'}</span></div>
   <p className="context-usage-note">取最近一次原生请求用量；记录时间 {formatConversationTimestamp(recent.time)}。会话累计用量不作为上下文占用。</p>
   {query.isPending&&<p role="status">正在读取会话 JSONL…</p>}
   {query.isError&&<p role="alert">{query.error instanceof Error?query.error.message:'上下文分类读取失败'}{data?'；以下保留上次读取结果。':''}</p>}
   {data&&<>
    <div className="context-usage-summary"><strong>可见文本分类估算 ≈ {number(total)} Token</strong><span>{data.partial?'部分日志':'已读取日志'}</span></div>
    <div className="context-usage-bar" role="img" aria-label="可见文本分类估算占比">{data.categories.filter(c=>c.tokens!=null&&c.tokens>0).map(c=><i key={c.id} title={`${c.name}：${share(c.tokens)}`} style={{width:share(c.tokens),background:colors[c.id]||'#8c8c8c'}}/>)}</div>
    <TableFrame label="上下文分类 Token" className="context-usage-table" style={{minWidth:540}} header={<><th>分类 / 来源</th><th>条数</th><th>估算 Token</th><th>分类估算占比</th></>}>
     {data.categories.map(c=><Fragment key={c.id}><tr><th scope="row"><div className="context-usage-label">{c.detail.length>0?<button type="button" aria-label={`${expanded[c.id]?'收起':'展开'}${c.name}明细`} aria-expanded={!!expanded[c.id]} onClick={()=>setExpanded(previous=>({...previous,[c.id]:!previous[c.id]}))}>{expanded[c.id]?'−':'+'}</button>:<span className="context-usage-spacer"/>}<b style={{background:colors[c.id]||'#8c8c8c'}}/>{c.name}</div></th><td>{c.tokens==null&&c.count===0?'—':number(c.count)}</td><td>{c.tokens==null?'未提供':`≈ ${number(c.tokens)}`}</td><td>{share(c.tokens)}</td></tr>{expanded[c.id]&&c.detail.map(d=><tr className="context-usage-detail" key={d.name}><th scope="row" title={d.name}>└ {d.name}</th><td>{number(d.count)}</td><td>≈ {number(d.tokens)}</td><td>{share(d.tokens)}</td></tr>)}</Fragment>)}
    </TableFrame>
    <p className="context-usage-note">分类按可见文本字符数 ÷ 3 向上取整粗估，占比以分类估算总和为分母，不能与原生总量直接对账。日志未提供的工具定义、图片 Token、隐藏指令及推理保持未知；原生截断也可能影响当前实际内容。</p>
    {data.warnings.length>0&&<p role="status" className="context-usage-warning">{data.warnings.join('；')}</p>}
    <footer className="context-usage-note">读取 {number(data.files_read)} 个文件 · {number(data.records_read)} 条记录 · {(data.bytes_read/1048576).toFixed(2)} MiB · 压缩 {number(data.compactions)} 次 · {formatConversationTimestamp(data.checked_at)}</footer>
   </>}
  </section>
 </Dialog>;
}
