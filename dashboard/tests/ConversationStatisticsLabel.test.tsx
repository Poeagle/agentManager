import {render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {ConversationStatisticsLabel,englishMetadataDuration,metadataDurationTitle,metadataTimestampTitle} from '../src/components/ConversationStatisticsLabel';
const base={sequence:1,turn_id:'turn',tokens:{total_tokens:1000},requests:3,tool_calls:8,tool_rounds:4,complete:true};
const interval={tokens:{total_tokens:200},requests:1,tool_calls:2,tool_rounds:1,complete:true,shared_messages:1};
const label=()=>document.querySelector('.session-chat-message-statistics')!;
describe('English message metadata',()=>{
 it('shows fixed field/value ordering and rounds before calls for the current interval',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval}}/>);expect(label()).toHaveTextContent('Total｜Input｜Cache｜Reasoning｜Output｜Est. Cr : 200 (—)｜—｜—｜—｜— · 1 round | 2 calls');expect(label()).toHaveAttribute('title',expect.stringContaining('Usage between completed Item boundaries'));
 });
 it('uses conclusion interval data instead of native turn totals',()=>{
  render(<ConversationStatisticsLabel statistics={{...base,interval,conclusion:{...interval,start_at:null,end_at:null,elapsed_ms:null}}}/>);expect(label()).not.toHaveTextContent('summary ·');expect(label()).toHaveTextContent('200 (—)｜');expect(label()).not.toHaveTextContent('1K');expect(label()).toHaveAttribute('title',expect.stringContaining('Usage between completed Final boundaries'));
 });
 it('omits redundant interval prefixes and colors only the Credit value and tool counts',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,cost:{amount:1.267,unit:'credits',complete:true}}}}/>);
  expect(label().textContent).toMatch(/^Total｜/);expect(label()).not.toHaveTextContent('step ·');
  expect(document.querySelector('.session-chat-estimated-cost')).toHaveTextContent('1.267');
  expect(document.querySelector('.session-chat-tool-counts')).toHaveTextContent('1 round | 2 calls');
  expect(document.querySelector('.session-chat-estimated-cost')).not.toHaveTextContent('Est. Cr');
 });
 it('explains an unavailable estimate without substituting zero or cumulative Credit',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,cost:{amount:100,unit:'credits',complete:true},interval:{...interval,cost:{amount:null,unit:'credits',complete:false}}}}/>);
  expect(document.querySelector('.session-chat-estimated-cost')).toHaveTextContent('—');expect(label()).not.toHaveTextContent('100');
  expect(label()).toHaveAttribute('title',expect.stringContaining('Pricing is unavailable'));
 });
 it('does not split or duplicate a shared model request',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,shared_messages:2}}}/>);expect(label()).toHaveTextContent('Shared request');expect(label()).toHaveAttribute('title',expect.stringContaining('2 updates share the same model request'));expect(label()).toHaveAttribute('title',expect.stringContaining('200 tokens'));
 });
 it('marks incomplete counters as lower bounds',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,complete:false}}}/>);expect(label()).toHaveTextContent('≥200 (—)｜');expect(label()).toHaveTextContent('≥1 round | ≥2 calls');
 });
 it('keeps legacy snapshots described as cumulative usage',()=>{
  render(<ConversationStatisticsLabel interval statistics={base}/>);expect(label()).toHaveTextContent('1K (—)｜');expect(label()).toHaveTextContent('4 rounds | 8 calls');expect(label()).toHaveAttribute('title',expect.stringContaining('Cumulative usage'));
 });
 it('shows cache hit percentage beside cached input and provides exact counters and pricing in the tooltip',()=>{
  const tokens={total_tokens:10200,input_tokens:10000,cached_input_tokens:9999,reasoning_output_tokens:50,output_tokens:200};
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,tokens,cost:{amount:3.21,unit:'credits',complete:true,rate_date:'2026-11-14'}}}}/>);
  expect(label()).toHaveTextContent('10.2K (3.21)｜10K｜10K (99.99%)｜50｜200');expect(screen.getByText('99.99%')).toHaveAttribute('class','session-chat-cache-hit');expect(label()).toHaveAttribute('title',expect.stringContaining('Cache 9,999'));expect(label()).toHaveAttribute('title',expect.stringContaining('included in Output'));
 });
 it('shows credit breakdown beside each token category',()=>{
  const tokens={total_tokens:1100,input_tokens:1000,cached_input_tokens:900,reasoning_output_tokens:20,output_tokens:100};
  render(<ConversationStatisticsLabel statistics={{...base,tokens,cost:{amount:3,unit:'credits',complete:true,breakdown:{input:1,cache:0.5,reasoning:0.3,output:1.5}}}}/>);
  expect(label()).toHaveTextContent('1.1K (3)｜1K (1)｜900 (0.5 | 90%)｜20 (0.3)｜100 (1.5)');
  expect(document.querySelectorAll('.session-chat-estimated-cost')).toHaveLength(5);
 });
 it('keeps zero-input and invalid cache ratios unknown and suppresses inapplicable Credit fields',()=>{
  const view=render(<ConversationStatisticsLabel statistics={{...base,tokens:{input_tokens:0,cached_input_tokens:0,total_tokens:0},cost:null}}/>);expect(label()).not.toHaveTextContent('Est. Cr');expect(screen.getByTitle(/Cache hit rate/)).toHaveTextContent('—');
  view.rerender(<ConversationStatisticsLabel statistics={{...base,tokens:{input_tokens:100,cached_input_tokens:101,total_tokens:100},cost:null}}/>);expect(screen.getByTitle(/Cache hit rate/)).toHaveTextContent('—');
 });
 it('marks partial credit estimates and never rounds tiny positive estimates to zero',()=>{
  render(<ConversationStatisticsLabel statistics={{...base,cost:{amount:.00001,unit:'credits',complete:false}}}/>);expect(label()).toHaveTextContent('<0.001*');
 });
 it('does not invent zero counters for unavailable statistics',()=>{
  render(<ConversationStatisticsLabel statistics={null} interval/>);expect(label()).toHaveTextContent('— rounds | — calls');expect(label()).not.toHaveTextContent('0 calls');
 });
 it('uses English units and timing tooltips',()=>{
  expect(englishMetadataDuration('本轮耗时 1时2分3秒')).toBe('Total time: 1h 2m 3s');expect(englishMetadataDuration('耗时 19秒')).toBe('Elapsed: 19s');expect(metadataDurationTitle('commentary')).toMatch(/^Time between/);expect(metadataTimestampTitle({id:'a',role:'assistant',text:'',timestamp:'2026-11-03T01:00:00Z'},true)).toMatch(/^Progress completion time:/);
 });
});
