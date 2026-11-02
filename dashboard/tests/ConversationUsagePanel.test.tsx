import {render,screen,within,fireEvent} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationUsagePanel} from '../src/components/ConversationUsagePanel';

it('explains cache hit rate with a visual input breakdown and keeps cumulative counters in expandable details',()=>{
 render(<ConversationUsagePanel usage={{last:{total_tokens:317934,input_tokens:317648,cached_input_tokens:315392,output_tokens:286,reasoning_output_tokens:286},total:{input_tokens:93669480,cached_input_tokens:90895104,total_tokens:94209471},window:475000}} observedAt="2026-11-02T03:32:39Z"/>);
 expect(within(screen.getByLabelText('本次缓存命中率')).getByText('99.3%')).toBeVisible();
 expect(screen.getByRole('img',{name:/未命中 2,256 Token/})).toBeVisible();
 expect(screen.getByRole('meter',{name:'上下文占用比例'})).toHaveAttribute('aria-valuenow',String(100*317934/475000));
 expect(screen.getByText('其中推理输出 286，已包含在输出中')).toBeVisible();
 fireEvent.click(screen.getByText('查看完整用量明细'));expect(screen.getByText('94,209,471')).toBeVisible();
});
it('keeps missing and invalid cache percentages unknown rather than inventing a hit rate',()=>{
 render(<ConversationUsagePanel usage={{last:{input_tokens:0,cached_input_tokens:0},total:{input_tokens:10,cached_input_tokens:20},window:null}} observedAt={null}/>);
 expect(within(screen.getByLabelText('本次缓存命中率')).getByText('—')).toBeVisible();expect(screen.getByText('用量记录时间：时间未知')).toBeVisible();
});
