import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationToolCall} from '../src/components/ConversationToolCall';

const block={
  type:'tool_use' as const,index:1,id:'tool-1',name:'Read',
  input:{file_path:'/project/README.md'},status:'completed' as const,
  result:'# Project',
};

it('uses the shared tool disclosure and reveals input and result on demand',()=>{
  const {container}=render(<ConversationToolCall block={block}/>);
  const card=container.querySelector('details');
  expect(card).toHaveAttribute('data-status','completed');
  expect(screen.getByText('Read')).toBeVisible();
  expect(screen.queryByText('工具调用完成')).not.toBeInTheDocument();
  expect(card).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('Read'));
  expect(card).toHaveAttribute('open');
  expect(screen.getByText(/"file_path": "\/project\/README.md"/)).toBeVisible();
  expect(screen.getByText('# Project')).toBeVisible();
});

it('keeps running tools collapsed like every other tool row',()=>{
  const {container}=render(<ConversationToolCall block={{...block,status:'running',result:undefined}}/>);
  const card=container.querySelector('details');
  expect(card).toHaveClass('session-chat-tool');
  expect(card).not.toHaveAttribute('open');
  expect(screen.getByText('运行中')).toBeVisible();
  expect(card.querySelector('.session-chat-tool-input')).not.toBeVisible();
  expect(screen.queryByText('正在调用工具')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Read'));
  expect(card).toHaveAttribute('open');
  expect(screen.getByText(/"file_path": "\/project\/README.md"/)).toBeVisible();
});

it.each(['running','completed','failed'] as const)('keeps %s tool rows in the same single-line disclosure shape', status=>{
  const {container}=render(<ConversationToolCall block={{...block,status,result:status==='running'?undefined:'output'}}/>);
  const card=container.querySelector('details')!;
  expect(card).not.toHaveAttribute('open');
  expect(card.querySelector('.session-chat-tool-input')).not.toBeVisible();
  const result=card.querySelector('.session-chat-tool-result');
  if(result)expect(result).not.toBeVisible();
});
