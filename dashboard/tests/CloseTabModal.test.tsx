import {act,fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {CloseTabModal} from '../src/components/CloseTabModal';

describe('session close actions',()=>{
  it('offers cancel, stop and delete, focuses cancel, and exposes no background-hide action',()=>{
    const cancel=vi.fn();render(<CloseTabModal label="测试会话" type="session" onStop={vi.fn()} onDelete={vi.fn()} onCancel={cancel}/>);
    expect(screen.getByRole('button',{name:'取消',exact:true})).toHaveFocus();expect(screen.getByRole('button',{name:'停止并关闭',exact:true})).toBeEnabled();expect(screen.getByRole('button',{name:'删除会话',exact:true})).toBeEnabled();expect(screen.queryByText(/隐藏/)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(['stop','delete'] as const)('locks repeated %s requests and retains errors for retry',async action=>{
    let reject!:(error:Error)=>void;const handler=vi.fn(()=>new Promise<void>((_,no)=>{reject=no;})),cancel=vi.fn();
    render(<CloseTabModal label="测试会话" type="session" onStop={action==='stop'?handler:vi.fn()} onDelete={action==='delete'?handler:vi.fn()} onCancel={cancel}/>);
    const button=screen.getByRole('button',{name:action==='stop'?'停止并关闭':'删除会话',exact:true});fireEvent.click(button);fireEvent.click(button);expect(handler).toHaveBeenCalledOnce();
    expect(screen.getByRole('button',{name:'取消',exact:true})).toBeDisabled();fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(cancel).not.toHaveBeenCalled();
    await act(async()=>reject(new Error('暂时失败，记录保留')));expect(screen.getByRole('alert')).toHaveTextContent('暂时失败，记录保留');expect(button).toBeEnabled();
  });
});
