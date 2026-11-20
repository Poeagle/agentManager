import {render,screen,within} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationDetailsPanel} from '../src/components/ConversationDetailsPanel';

it('compares recent and cumulative usage in the overview',()=>{
 render(<ConversationDetailsPanel
   usage={{last:{total_tokens:317934,input_tokens:317648,cached_input_tokens:315392,output_tokens:286,reasoning_output_tokens:286},total:{input_tokens:93669480,cached_input_tokens:90895104,total_tokens:94209471},window:475000}}
   model="deepseek-v4.1-flash" state="等待输入"/>);
 const table=screen.getByRole('table',{name:'Token 用量'});
 const hit=within(table).getByRole('rowheader',{name:'缓存命中率'}).parentElement!;
 expect(within(hit).getAllByRole('cell').map(cell=>cell.textContent)).toEqual(['99.3%','97.0%']);
 const input=within(table).getByRole('rowheader',{name:'未缓存输入'}).parentElement!;
 expect(within(input).getAllByRole('cell').map(cell=>cell.textContent)).toEqual(['2,256','2,774,376']);
 expect(within(table).getByRole('rowheader',{name:'上下文占用'}).parentElement).toHaveAttribute('title','317,934 / 475,000 Token');
 const stats=screen.getByRole('table',{name:'会话统计'});
 expect(within(stats).getByRole('rowheader',{name:'当前模型'}).parentElement).toHaveTextContent('deepseek-v4.1-flash');
 expect(stats).toHaveTextContent('等待输入');
 expect(screen.queryByText('原生会话编号')).not.toBeInTheDocument();
});

it('keeps missing and invalid cache percentages unknown rather than inventing values',()=>{
 render(<ConversationDetailsPanel usage={{last:{input_tokens:0,cached_input_tokens:0},total:{input_tokens:10,cached_input_tokens:20},window:null}}/>);
 const row=screen.getByRole('rowheader',{name:'缓存命中率'}).parentElement!;
 expect(within(row).getAllByRole('cell').map(cell=>cell.textContent)).toEqual(['—','—']);
});
