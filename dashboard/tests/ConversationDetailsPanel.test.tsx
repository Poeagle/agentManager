import {render,screen,within} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ConversationDetailsPanel} from '../src/components/ConversationDetailsPanel';

it('shows usage, runtime and metadata in one always-visible grouped table',()=>{
 render(<ConversationDetailsPanel
   usage={{last:{total_tokens:317934,input_tokens:317648,cached_input_tokens:315392,output_tokens:286,reasoning_output_tokens:286},total:{input_tokens:93669480,cached_input_tokens:90895104,total_tokens:94209471},window:475000}}
   observedAt="2026-11-02T03:32:39Z"
   runtime={[{label:'当前模型',value:'deepseek-v4.1-flash',detail:'服务 xindu'},{label:'当前分支',value:'feat/details',detail:'工作区 2 项变更'}]}
   nativeId="native-1" limits={[{used_percent:25,minutes:10080,resets_at:1900000000}]} checkedAt="2026-11-02T03:33:39Z"/>);
 const table=screen.getByRole('table',{name:'Token 用量与运行环境'});
 expect(screen.getAllByRole('table')).toHaveLength(1);
 expect(within(table).getByRole('rowheader',{name:'本次缓存命中率'}).parentElement).toHaveTextContent('99.3%');
 expect(within(table).getByRole('rowheader',{name:'上下文占用'}).parentElement).toHaveTextContent('317,934 / 475,000');
 expect(within(table).getByRole('rowheader',{name:'当前模型'}).parentElement).toHaveTextContent('deepseek-v4.1-flash');
 expect(within(table).getByRole('rowheader',{name:'周额度'}).parentElement).toHaveTextContent('剩余 75%');
 expect(within(table).getByRole('rowheader',{name:'原生会话编号'}).parentElement).toHaveTextContent('native-1');
 expect(screen.queryByText('查看完整用量明细')).not.toBeInTheDocument();
});

it('keeps missing and invalid cache percentages unknown rather than inventing values',()=>{
 render(<ConversationDetailsPanel usage={{last:{input_tokens:0,cached_input_tokens:0},total:{input_tokens:10,cached_input_tokens:20},window:null}} observedAt={null} runtime={[]} nativeId="native-2" limits={[]} checkedAt={null}/>);
 const table=screen.getByRole('table',{name:'Token 用量与运行环境'});
 expect(within(table).getByRole('rowheader',{name:'本次缓存命中率'}).parentElement).toHaveTextContent('—');
 expect(within(table).getByRole('rowheader',{name:'累计缓存命中率'}).parentElement).toHaveTextContent('—');
 expect(within(table).getByRole('rowheader',{name:'用量记录时间'}).parentElement).toHaveTextContent('时间未知');
});
