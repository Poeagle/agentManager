import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationProgressPending} from '../src/components/ConversationProgressPending';
import {pendingProgressStatistics,withObservedToolCounts} from '../src/lib/conversation-progress';
import type {ConversationProgressSegment,ConversationProgressStatistics} from '../src/lib/api';

const startedAt='2026-11-15T00:00:00Z',now=Date.parse(startedAt)+12000;
const tool={id:'one',label:'Run command · npm test',status:'running' as const,started_at:startedAt,completed_at:null,duration_ms:null,input_preview:'npm test -- --run',result_preview:'First output'};
it('renders standard metadata and one collapsed tool, waits after completion, and resets disclosure for the next tool',()=>{
  const props={number:7,startedAt,now,statistics:null,connected:true};
  const view=render(<ConversationProgressPending {...props} tool={tool}/>);
  expect(screen.getByLabelText('进展序号 7')).toBeVisible();expect(document.querySelector('time')).toHaveAttribute('datetime',startedAt);
  expect(document.querySelector('.session-chat-metadata-row')).toHaveTextContent('Total｜Input｜Cache｜Reasoning｜Output｜Est. Cr :');expect(screen.getByText('Elapsed: 12s')).toBeVisible();
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

it('subtracts both the total and each priced token category for a pending Item',()=>{
  const prior={...previous,cost:{amount:7,unit:'credits',complete:true,breakdown:{input:1,cache:2,output:4,reasoning:3}}};
  const segment={...live.segment!,cost:{amount:12,unit:'credits',complete:true,breakdown:{input:2,cache:3,output:7,reasoning:5}}};
  const pending=pendingProgressStatistics({...live,segment},prior,true);
  expect(pending?.interval?.cost).toMatchObject({amount:5,breakdown:{input:1,cache:1,output:3,reasoning:2}});
  expect(pending?.interval?.tokens).toEqual({total_tokens:200});
});

it('uses the first native step after an insertion without a baseline from the previous Progress',()=>{
  const segment={...previous,id:'after-input',requests:1,tokens:{total_tokens:600}};
  const step={...segment,shared_messages:1,segment_id:segment.id,after_message_id:null,after_sequence:null,start_at:startedAt};
  expect(pendingProgressStatistics({...live,segment,step},undefined,false)?.interval).toEqual(step);
  expect(pendingProgressStatistics({...live,segment,step},previous,true,{id:'previous-item'})).toBeNull();
});

it('keeps a 100-character command summary in the header while expanded content contains only live results',()=>{
  const command='echo '+ '界'.repeat(100)+' tail';
  const view=render(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} connected tool={{...tool,input_preview:command}}/>);
  const label=document.querySelector('.session-chat-live-tool-label')!;
  expect(label.textContent).toBe('echo '+ '界'.repeat(95)+'…');expect(label).toHaveAttribute('title',command);
  expect(document.querySelector('.session-chat-tool-input')).toBeNull();
  fireEvent.click(document.querySelector('summary')!);expect(document.querySelector('.session-chat-live-tool-details')).toHaveTextContent('First output');expect(document.querySelector('.session-chat-live-tool-details')).not.toHaveTextContent('echo');
  view.rerender(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} connected tool={{...tool,input_preview:command,status:'completed',result_preview:'Final result'}}/>);
  expect(label.textContent).toBe('echo '+ '界'.repeat(95)+'…');expect(document.querySelector('summary')).toHaveTextContent('Waiting');expect(screen.getByText('Final result')).toBeVisible();
});
it('flattens multiline commands and leaves short commands intact',()=>{
  render(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} connected tool={{...tool,input_preview:'echo one\n  echo two'}}/>);
  expect(document.querySelector('.session-chat-live-tool-label')).toHaveTextContent('echo one echo two');expect(document.querySelector('.session-chat-live-tool-label')).not.toHaveTextContent('…');
});
it('hides unavailable elapsed time instead of displaying an empty timing placeholder',()=>{
 const props={number:7,now,statistics:null,connected:true};
 const view=render(<ConversationProgressPending {...props} startedAt={null}/>);
 expect(document.querySelector('.session-chat-message-duration')).toBeNull();expect(screen.queryByText(/Elapsed:/)).toBeNull();
 view.rerender(<ConversationProgressPending {...props} startedAt="invalid"/>);
 expect(document.querySelector('.session-chat-message-duration')).toBeNull();
 view.rerender(<ConversationProgressPending {...props} startedAt={startedAt}/>);
 expect(screen.getByText('Elapsed: 12s')).toBeVisible();
});

it('shows the latest native request token snapshot in the active Item',()=>{
 const liveUsage={native_id:'native',observed_at:startedAt,usage:{total:{total_tokens:9000},last:{total_tokens:2400,input_tokens:2200,cached_input_tokens:2100,reasoning_output_tokens:100,output_tokens:200},window:40000}};
 const view=render(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} liveUsage={liveUsage} connected tool={tool}/>);
 expect(screen.getByText(/Latest request · 2.4K tokens · input 2.2K · cache 2.1K · output 200/)).toBeVisible();
 view.rerender(<ConversationProgressPending number={7} startedAt={startedAt} now={now} statistics={null} liveUsage={liveUsage} connected tool={tool} showStatistics={false}/>);
 expect(screen.queryByText(/Latest request/)).not.toBeInTheDocument();
});

it('uses activity snapshots only as a fallback and never double-counts a tool already assigned to a recorded request',()=>{
 const fallback=withObservedToolCounts(null,2,'turn');expect(fallback).toMatchObject({tool_calls:2,tool_rounds:1,complete:false,tokens:null});
 const step={...live,sequence:0,segment_id:'segment',tokens:null,tool_calls:0,tool_rounds:0};expect(withObservedToolCounts(step,2,'turn')).toBe(step);
});
