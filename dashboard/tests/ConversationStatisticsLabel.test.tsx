import {render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {ConversationStatisticsLabel,englishMetadataDuration,metadataDurationTitle,metadataTimestampTitle} from '../src/components/ConversationStatisticsLabel';
const base={sequence:1,turn_id:'turn',tokens:{total_tokens:1000},requests:3,tool_calls:8,tool_rounds:4,complete:true};
const interval={tokens:{total_tokens:200},requests:1,tool_calls:2,tool_rounds:1,complete:true,shared_messages:1};
describe('English message metadata',()=>{
 it('shows progress interval costs',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval} as typeof base}/>);expect(screen.getByText('step · token: 200 · tools: 2 calls / 1 round')).toBeVisible();expect(screen.getByText(/step/)).toHaveAttribute('title',expect.stringContaining('since the previous progress request'));
 });
 it('keeps final answers labelled as whole-turn totals',()=>{
  render(<ConversationStatisticsLabel statistics={{...base,interval} as typeof base}/>);expect(screen.getByText('turn · token: 1K · tools: 8 calls / 4 rounds')).toBeVisible();
 });
 it('does not split a shared model request',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,shared_messages:2}} as typeof base}/>);const label=screen.getByText('step · token: shared · tools: shared');expect(label).toHaveAttribute('title',expect.stringContaining('2 updates share the same model request'));expect(label).toHaveAttribute('title',expect.stringContaining('200 tokens'));
 });
 it('marks incomplete intervals as lower bounds',()=>{
  render(<ConversationStatisticsLabel interval statistics={{...base,interval:{...interval,complete:false}} as typeof base}/>);expect(screen.getByText('step · token: ≥200 · tools: ≥2 calls / ≥1 round')).toBeVisible();
 });
 it('keeps legacy snapshots described as cumulative usage',()=>{
  render(<ConversationStatisticsLabel interval statistics={base}/>);expect(screen.getByText('token: 1K · tools: 8/4')).toHaveAttribute('title',expect.stringContaining('Cumulative usage'));
 });
 it('uses English units and tooltips',()=>{
  expect(englishMetadataDuration('本轮耗时 1时2分3秒')).toBe('Total: 1h 2m 3s');expect(englishMetadataDuration('耗时 19秒')).toBe('Elapsed: 19s');expect(metadataDurationTitle('commentary')).toMatch(/^Time between/);expect(metadataTimestampTitle({id:'a',role:'assistant',text:'',timestamp:'2026-11-03T01:00:00Z'},true)).toMatch(/^Progress completion time:/);
 });
});
