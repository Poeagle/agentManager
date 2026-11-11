import {render,screen} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {GitPanel} from '../src/components/GitPanel';
import {api} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({api:{git:{status:vi.fn(),log:vi.fn()}}}));
vi.mock('../src/components/DiffComponents',()=>({UnifiedDiff:()=>null,SplitDiff:()=>null}));
it('shows the actual Git failure instead of claiming an existing repository is missing',async()=>{
 vi.mocked(api.git.status).mockRejectedValue(new Error('Git 目录访问权限不足'));vi.mocked(api.git.log).mockResolvedValue({commits:[]});
 render(<GitPanel projectPath="/project" isVisible/>);
 expect(await screen.findByRole('alert')).toHaveTextContent('Git 目录访问权限不足');expect(screen.queryByText('Not a git repository')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'重试'})).toBeVisible();
});
