import {render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {ConversationStatisticsLabel,englishMetadataDuration,metadataDurationTitle,metadataTimestampTitle} from '../src/components/ConversationStatisticsLabel';
const base={sequence:1,turn_id:'turn',tokens:{total_tokens:1000},requests:3,tool_calls:8,tool_rounds:4,complete:true};
const interval={tokens:{total_tokens:200},requests:1,tool_calls:2,tool_rounds:1,complete:true,shared_messages:1};
const label=()=>document.querySelector('.session-chat-message-statistics')!;
describe('English message metadata',()=>{
 it('shows fixed field/value ordering and rounds before calls for the current interval',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval}}/>);expect(label()).toHaveTextContent('Total｜Input｜Cache｜Reasoning｜Output｜Est. $ : 200 (—)｜—｜—｜—｜— · 1 round | 2 calls');expect(label()).toHaveAttribute('title',expect.stringContaining('Usage for this Item'));
 });
 it('uses conclusion interval data instead of native turn totals',()=>{
  render(<ConversationStatisticsLabel statistics={{...base,interval,conclusion:{...interval,start_at:null,end_at:null,elapsed_ms:null}}}/>);expect(label()).not.toHaveTextContent('summary ·');expect(label()).toHaveTextContent('200 (—)｜');expect(label()).not.toHaveTextContent('1K');expect(label()).toHaveAttribute('title',expect.stringContaining('Usage between completed Final boundaries'));
 });
 it('omits redundant interval prefixes and colors only the USD value and tool counts',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,cost:{amount:1.267,unit:'credits',complete:true}}}}/>);
  expect(label().textContent).toMatch(/^Total｜/);expect(label()).not.toHaveTextContent('step ·');
  expect(document.querySelector('.session-chat-estimated-cost')).toHaveTextContent('$0.05');
  expect(document.querySelector('.session-chat-tool-counts')).toHaveTextContent('1 round | 2 calls');
  expect(document.querySelector('.session-chat-estimated-cost')).not.toHaveTextContent('Est. Cr');
 });
 it('explains an unavailable estimate without substituting zero or cumulative Credit',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,cost:{amount:100,unit:'credits',complete:true},interval:{...interval,cost:{amount:null,unit:'credits',complete:false}}}}/>);
  expect(document.querySelector('.session-chat-estimated-cost')).toHaveTextContent('—');expect(label()).not.toHaveTextContent('100');
  expect(label()).toHaveAttribute('title',expect.stringContaining('Pricing is unavailable'));
 });
 it('uses the same parentheses for every token count with API currency',()=>{
  const tokens={total_tokens:120,input_tokens:100,cached_input_tokens:60,reasoning_output_tokens:5,output_tokens:20};
  render(<ConversationStatisticsLabel statistics={{...base,tokens,cost:{amount:0.03,unit:'CNY',basis:'api',complete:true,breakdown:{input:0.01,cache:0.002,reasoning:0.001,output:0.018}}}}/>);
  expect(label()).toHaveTextContent('120 (¥0.03)｜40 (¥0.01)｜60 (<¥0.01 | 60%)｜5 (<¥0.01)｜20 (¥0.02)');
 });
 it('does not split or duplicate a shared model request',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,shared_messages:2}}}/>);expect(label()).toHaveTextContent('Shared request');expect(label()).toHaveAttribute('title',expect.stringContaining('2 updates share the same model request'));expect(label()).toHaveAttribute('title',expect.stringContaining('200 tokens'));
 });
 it('marks incomplete counters as lower bounds',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,complete:false}}}/>);expect(label()).toHaveTextContent('≥200 (—)｜');expect(label()).toHaveTextContent('≥1 round | ≥2 calls');
 });
 it('keeps legacy snapshots described as cumulative usage',()=>{
  render(<ConversationStatisticsLabel interval statistics={base}/>);expect(label()).toHaveTextContent('1K (—)｜');expect(label()).toHaveTextContent('3 rounds | 8 calls');expect(label()).toHaveAttribute('title',expect.stringContaining('Cumulative usage'));
 });
 it('shows cache hit percentage beside cached input and provides exact counters and pricing in the tooltip',()=>{
  const tokens={total_tokens:10200,input_tokens:10000,cached_input_tokens:9999,reasoning_output_tokens:50,output_tokens:200};
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,tokens,cost:{amount:3.21,unit:'credits',complete:true,rate_date:'2026-11-14'}}}}/>);
  expect(label()).toHaveTextContent('10.2K ($0.13)｜1 (—)｜10K (— | 99.99%)｜50 (—)｜200 (—)');expect(screen.getByText('99.99%')).toHaveAttribute('class','session-chat-cache-hit');expect(label()).toHaveAttribute('title',expect.stringContaining('Input 1 (uncached); Cache 9,999; total input 10,000'));expect(label()).toHaveAttribute('title',expect.stringContaining('included in Output'));
 });
 it('shows the recorded cache rate for incomplete usage when total and output determine input',()=>{
  const tokens={total_tokens:1000,input_tokens:null,cached_input_tokens:800,reasoning_output_tokens:20,output_tokens:100};
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,coverage:'partial',reasons:['missing_usage'],complete:false,tokens}}}/>);
  expect(label()).toHaveTextContent('1K (—)｜100｜800 (88.89%)｜20｜100');
  expect(label()).toHaveAttribute('title',expect.stringContaining('total input 900; cache hit 88.89%'));
  expect(label()).toHaveAttribute('title',expect.stringContaining('有请求未上报完整用量'));
 });
 it('keeps cache ratios unknown when native counters conflict',()=>{
  const tokens={total_tokens:1000,input_tokens:900,cached_input_tokens:800,reasoning_output_tokens:20,output_tokens:100};
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,reasons:['counter_mismatch'],complete:false,tokens}}}/>);
  expect(label()).toHaveTextContent('≥1K (—)｜—｜≥800 (—)｜≥20｜≥100');
 });
 it('shows credit breakdown beside each token category',()=>{
  const tokens={total_tokens:1100,input_tokens:1000,cached_input_tokens:900,reasoning_output_tokens:20,output_tokens:100};
  render(<ConversationStatisticsLabel statistics={{...base,tokens,cost:{amount:3,unit:'credits',complete:true,breakdown:{input:1,cache:0.5,reasoning:0.3,output:1.5}}}}/>);
  expect(label()).toHaveTextContent('1.1K ($0.12)｜100 ($0.04)｜900 ($0.02 | 90%)｜20 ($0.01)｜100 ($0.06)');
  expect(document.querySelectorAll('.session-chat-estimated-cost')).toHaveLength(5);
 });
 it('keeps zero-input and invalid cache ratios unknown and suppresses inapplicable Credit fields',()=>{
  const view=render(<ConversationStatisticsLabel statistics={{...base,tokens:{input_tokens:0,cached_input_tokens:0,total_tokens:0},cost:null}}/>);expect(label()).not.toHaveTextContent('Est. Cr');expect(screen.getByTitle(/Cache hit rate/)).toHaveTextContent('—');
  view.rerender(<ConversationStatisticsLabel statistics={{...base,tokens:{input_tokens:100,cached_input_tokens:101,total_tokens:100},cost:null}}/>);expect(screen.getByTitle(/Cache hit rate/)).toHaveTextContent('—');
  expect(label()).toHaveAttribute('title',expect.stringContaining('Input unknown (uncached)'));
 });
 it('distinguishes a fully cached request from one with missing cache counters',()=>{
  const full={input_tokens:100,cached_input_tokens:100,output_tokens:20,total_tokens:120};
  const view=render(<ConversationStatisticsLabel statistics={{...base,tokens:full,cost:null}}/>);
  expect(label()).toHaveTextContent('120｜0｜100 (100%)');
  view.rerender(<ConversationStatisticsLabel statistics={{...base,tokens:{...full,cached_input_tokens:null},cost:null}}/>);
  expect(label()).toHaveTextContent('120｜—｜—');
  expect(label()).toHaveAttribute('title',expect.stringContaining('total input 100'));
 });
 it('marks partial credit estimates and never rounds tiny positive estimates to zero',()=>{
  render(<ConversationStatisticsLabel statistics={{...base,cost:{amount:.00001,unit:'credits',complete:false}}}/>);expect(label()).toHaveTextContent('<$0.01*');
 });
 it('does not invent zero counters for unavailable statistics',()=>{
  render(<ConversationStatisticsLabel statistics={null} interval/>);expect(label()).toHaveTextContent('— rounds | — calls');expect(label()).not.toHaveTextContent('0 calls');
 });
 it('distinguishes a pending receipt from a recorded zero-tool request',()=>{
  const pending={...interval,coverage:'pending' as const,complete:false,tokens:null,requests:0,tool_calls:0,tool_rounds:0};
  const view=render(<ConversationStatisticsLabel interval statistics={{...base,interval:pending}}/>);
  expect(label()).toHaveTextContent(/^等待用量回执$/);
  view.rerender(<ConversationStatisticsLabel interval statistics={{...base,interval:{...pending,tool_calls:2,tool_rounds:1}}}/>);
  expect(label()).toHaveTextContent('— rounds | 2 calls');
  view.rerender(<ConversationStatisticsLabel interval statistics={{...base,interval:{...pending,coverage:'complete',complete:true,requests:1,tokens:{total_tokens:200}}}}/>);
  expect(label()).toHaveTextContent('1 round | 0 calls');
  expect(label()).not.toHaveTextContent('等待用量回执');
 });
 it('uses English units and timing tooltips',()=>{
  expect(englishMetadataDuration('本轮耗时 1时2分3秒')).toBe('Total time: 1h 2m 3s');expect(englishMetadataDuration('耗时 19秒')).toBe('Elapsed: 19s');expect(metadataDurationTitle('commentary')).toMatch(/^Time between/);expect(metadataTimestampTitle({id:'a',role:'assistant',text:'',timestamp:'2026-11-03T01:00:00Z'},true)).toMatch(/^Progress completion time:/);
 });
});
it('updates each token category with its USD-equivalent estimate while a Progress is live',()=>{
 const tokens={total_tokens:1100000,input_tokens:1000000,cached_input_tokens:900000,reasoning_output_tokens:10000,output_tokens:100000};
 const statistics={...base,interval:{...interval,tokens,cost:{amount:1.29,unit:'USD',basis:'public_usd_reference',complete:true,rate_date:'2026-11-22',breakdown:{input:0.2,cache:0.09,reasoning:0.1,output:1}}}};
 const view=render(<ConversationStatisticsLabel interval statistics={statistics}/>);
 expect(label()).toHaveTextContent('1.1M ($1.29)｜100K ($0.20)｜900K ($0.09 | 90%)｜10K ($0.10)｜100K ($1.00)');
 expect(label()).toHaveAttribute('title',expect.stringContaining('Codex Credits converted at 25 Credits per USD'));
 view.rerender(<ConversationStatisticsLabel interval statistics={{...statistics,interval:{...statistics.interval,cost:{...statistics.interval.cost,amount:1.58,breakdown:{input:0.3,cache:0.08,reasoning:0.2,output:1.2}}}}}/>);
 expect(label()).toHaveTextContent('1.1M ($1.58)｜100K ($0.30)｜900K ($0.08 | 90%)｜10K ($0.20)｜100K ($1.20)');
});
