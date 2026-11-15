import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationProgressPending} from '../src/components/ConversationProgressPending';
import {pendingProgressStatistics} from '../src/lib/conversation-progress';
import type {ConversationProgressSegment,ConversationProgressStatistics} from '../src/lib/api';

const startedAt='2026-11-15T00:00:00Z',now=Date.parse(startedAt)+12000;
const tool={id:'one',label:'Run command · npm test',status:'running' as const,started_at:startedAt,completed_at:null,duration_ms:null,input_preview:'npm test -- --run',result_preview:'First output'};
it('renders standard metadata and one collapsed tool, waits after completion, and resets disclosure for the next tool',()=>{
  const props={number:7,startedAt,now,statistics:null,connected:true};
  const view=render(<ConversationProgressPending {...props} tool={tool}/>);
  expect(screen.getByLabelText('进展序号 7')).toBeVisible();expect(document.querySelector('time')).toHaveAttribute('datetime',startedAt);
  expect(document.querySelector('.session-chat-metadata-row')).toHaveTextContent('step · token: — · tools: —');expect(screen.getByText('Elapsed: 12s')).toBeVisible();
  const summary=document.querySelector('summary')!;expect(summary).toHaveTextContent('npm test');expect(screen.getByText('First output')).not.toBeVisible();
  fireEvent.click(summary);expect(screen.getByText('First output')).toBeVisible();expect(screen.getByText('npm test -- --run')).toBeVisible();expect(document.querySelector('.session-chat-live-tool-details')).toHaveTextContent('First output');expect(document.querySelector('.session-chat-live-tool-details')).not.toHaveTextContent('npm test');
  view.rerender(<ConversationProgressPending {...props} tool={{...tool,status:'completed',result_preview:'Tests passed'}}/>);
  expect(summary).toHaveTextContent('Waiting');expect(summary).toHaveTextContent('npm test');expect(screen.getByText('Tests passed')).toBeVisible();
  view.rerender(<ConversationProgressPending {...props} tool={{...tool,id:'two',label:'Run command · npm run build',input_preview:'npm run build',result_preview:'Compiling'}}/>);
  expect(document.querySelectorAll('details')).toHaveLength(1);expect(document.querySelector('details')).not.toHaveAttribute('open');expect(document.querySelector('summary')).toHaveTextContent('npm run build');expect(screen.queryByText('Tests passed')).not.toBeInTheDocument();
});
const previous:ConversationProgressSegment={id:'segment',start_at:startedAt,end_at:null,end_reason:null,elapsed_ms:null,tokens:{total_tokens:1000},requests:1,tool_calls:2,tool_rounds:1,complete:true};
const live:ConversationProgressStatistics={turn_id:'turn',tokens:null,requests:2,tool_calls:4,tool_rounds:2,complete:true,segment:{...previous,tokens:{total_tokens:1200},requests:2,tool_calls:4,tool_rounds:2}};
it('shows this update usage without reusing cumulative segment totals',()=>{
  expect(pendingProgressStatistics(live,previous,true)).toMatchObject({tokens:{total_tokens:200},requests:1,tool_calls:2,tool_rounds:1});
  expect(pendingProgressStatistics({...live,segment:previous},previous,true)?.tokens).toBeNull();
});
it('keeps usage unknown across missing, incomplete, changed or regressing baselines',()=>{
  expect(pendingProgressStatistics(live,undefined,true)).toBeNull();expect(pendingProgressStatistics(live,{...previous,id:'other'},true)).toBeNull();
  expect(pendingProgressStatistics(live,{...previous,complete:false},true)).toBeNull();expect(pendingProgressStatistics(live,{...previous,requests:9},true)).toBeNull();
  expect(pendingProgressStatistics(null,previous,true)).toBeNull();
});

it('keeps a 40-character command summary in the header while expanded content contains only live results',()=>{
  const command='echo '+ '界'.repeat(40)+' tail';
  const view=render(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} connected tool={{...tool,input_preview:command}}/>);
  const label=document.querySelector('.session-chat-live-tool-label')!;
  expect(label.textContent).toBe('echo '+ '界'.repeat(35)+'…');expect(label).toHaveAttribute('title',command);
  expect(document.querySelector('.session-chat-tool-input')).toBeNull();
  fireEvent.click(document.querySelector('summary')!);expect(document.querySelector('.session-chat-live-tool-details')).toHaveTextContent('First output');expect(document.querySelector('.session-chat-live-tool-details')).not.toHaveTextContent('echo');
  view.rerender(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} connected tool={{...tool,input_preview:command,status:'completed',result_preview:'Final result'}}/>);
  expect(label.textContent).toBe('echo '+ '界'.repeat(35)+'…');expect(document.querySelector('summary')).toHaveTextContent('Waiting');expect(screen.getByText('Final result')).toBeVisible();
});
it('flattens multiline commands and leaves short commands intact',()=>{
  render(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} connected tool={{...tool,input_preview:'echo one\n  echo two'}}/>);
  expect(document.querySelector('.session-chat-live-tool-label')).toHaveTextContent('echo one echo two');expect(document.querySelector('.session-chat-live-tool-label')).not.toHaveTextContent('…');
});
