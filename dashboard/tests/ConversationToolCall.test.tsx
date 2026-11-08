import {render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {ConversationToolCall} from '../src/components/ConversationToolCall';

describe('ConversationToolCall',()=>{
  it('renders running input then updates the same tool card with its result',()=>{
    const {rerender}=render(<ConversationToolCall block={{type:'tool_use',index:1,id:'tool-1',name:'Bash',input:{command:'pwd'},status:'running'}}/>);
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText(/"command": "pwd"/)).toBeInTheDocument();
    rerender(<ConversationToolCall block={{type:'tool_use',index:1,id:'tool-1',name:'Bash',input:{command:'pwd'},status:'completed',result:'/workspace'}}/>);
    expect(screen.getByText('完成')).toBeInTheDocument();
    expect(screen.getByText('/workspace')).toBeInTheDocument();
  });
  it('shows failed tool calls distinctly',()=>{
    const {container}=render(<ConversationToolCall block={{type:'tool_use',index:0,id:'tool-2',name:'Read',input:{file_path:'missing.ts'},status:'failed',result:'not found',is_error:true}}/>);
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(container.querySelector('[data-status="failed"]')).toBeInTheDocument();
  });
});
