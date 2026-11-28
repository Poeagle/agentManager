import {fireEvent,render,screen,within} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationCacheDropGroup} from '../src/components/ConversationCacheDrop';
import type {SessionCacheDrop} from '../src/lib/session-metadata';

const sample=(requestId:string,input:number,cached:number):SessionCacheDrop['current']=>({
 input_id:'input',input_at:null,turn_id:'turn',request_id:requestId,request_at:'2026-11-28T12:00:00Z',
 input_tokens:input,cached_input_tokens:cached,hit_rate:input?cached/input:0,model:'model',speed:null,environment:null,account:null,
});
const drop=(id:string,extra:number):SessionCacheDrop=>({
 id,at:`2026-11-28T12:00:0${id === 'one' ? '1' : id === 'two' ? '2' : '3'}Z`,previous:sample(`${id}-previous`,100,80),
 current:sample(`${id}-current`,100,20),elapsed_ms:1000,interval_kind:'request',decrease_pp:60,extra_cost:{amount:extra,unit:'USD'},
 factors:['input_gap'],confirmed_cause:null,
});

it('collapses repeated cache notices to the first line and shows the combined net cost',()=>{
 render(<ConversationCacheDropGroup drops={[drop('one',0.03),drop('two',-0.01),drop('three',0.04)]}/>);
 expect(screen.getAllByRole('group',{name:'缓存命中输入减少'})).toHaveLength(1);
 expect(screen.getByText('共 3 条 · 累计净多耗 0.06')).toBeVisible();
 const expand=screen.getByRole('button',{name:'展开 3 条缓存记录'});
 expect(expand).toHaveAttribute('aria-expanded','false');
 fireEvent.click(expand);
 expect(screen.getAllByRole('group',{name:'缓存命中输入减少'})).toHaveLength(3);
 expect(screen.getByRole('button',{name:'收起 3 条缓存记录'})).toHaveAttribute('aria-expanded','true');
 expect(within(screen.getAllByRole('group',{name:'缓存命中输入减少'})[1]).getByText('预估节省 0.01')).toBeVisible();
});

it('shows the group count when the combined amount cannot be estimated',()=>{
 const missingCost={...drop('two',0),extra_cost:null};
 render(<ConversationCacheDropGroup drops={[drop('one',0.03),missingCost]}/>);
 expect(screen.getByText('共 2 条 · 累计净多耗未知')).toBeVisible();
});
