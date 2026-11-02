import {useState} from 'react';import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AiSourceFields} from '../src/components/AiSourceFields';import type {AiSource,AiClientDiscovery} from '../src/lib/ai-source';import {fetchJSON} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({fetchJSON:vi.fn()}));
let query:QueryClient;
const codex:AiClientDiscovery={kind:'codex',installed:true,executable:'/usr/local/bin/codex',version:'0.166.0',login:'detected',credential_source:'local',expires_at:null,default_model:'model-a',models:[{id:'model-a',name:'Model A'},{id:'model-b',name:'Model B'}],models_observed_at:null};
beforeEach(()=>{query=new QueryClient({defaultOptions:{queries:{retry:false}}});vi.mocked(fetchJSON).mockReset().mockResolvedValue({clients:[codex,{...codex,kind:'claude',installed:false,executable:null,version:null,default_model:null,models:[],login:'not_detected'}]});});afterEach(()=>query.clear());
function Harness(){const [source,setSource]=useState<AiSource>({kind:'api',executable:'/old/api/path'}),[model,setModel]=useState('deepseek-flash');return <><AiSourceFields value={source} model={model} onModelChange={setModel} onChange={(next,suggested)=>{if(next.kind!==source.kind)setModel(suggested||'');setSource(next);}}/><input aria-label="选中的模型" value={model} readOnly/></>;}
const mount=()=>render(<QueryClientProvider client={query}><Harness/></QueryClientProvider>);
describe('automatic client metadata',()=>{
 it('detects once without inference and replaces stale source/model overrides when changing provider',async()=>{
  mount();await waitFor(()=>expect(query.getQueryData(['ai-sources','discovery'])).toBeDefined());fireEvent.click(screen.getByRole('radio',{name:/Codex/}));expect(screen.getByLabelText('选中的模型')).toHaveValue('model-a');expect(screen.getByText('已找到 codex 0.166.0')).toBeVisible();expect(screen.getByText('已检测到本地登录信息')).toBeVisible();expect(screen.getByRole('combobox',{name:'客户端模型'})).toHaveValue('model-a');fireEvent.change(screen.getByRole('combobox',{name:'客户端模型'}),{target:{value:'model-b'}});expect(screen.getByLabelText('选中的模型')).toHaveValue('model-b');fireEvent.click(screen.getByText('高级设置：程序路径与额外域名'));expect(screen.getByText('程序路径：/usr/local/bin/codex')).toBeVisible();expect(screen.getByLabelText('AI 程序路径')).toHaveValue('');expect(screen.getByLabelText('AI 程序路径')).toHaveAttribute('placeholder','/usr/local/bin/codex');expect(fetchJSON).toHaveBeenCalledTimes(1);expect(vi.mocked(fetchJSON).mock.calls[0][0]).toBe('/ai-sources');
  fireEvent.click(screen.getByRole('radio',{name:/Claude/}));expect(screen.getByLabelText('选中的模型')).toHaveValue('');expect(screen.getByText('未找到默认客户端，不会自动安装。')).toBeVisible();
 });
 it('explicit refresh only reloads metadata and supports old cached installed-only responses during updates',async()=>{
  vi.mocked(fetchJSON).mockResolvedValueOnce({clients:[{kind:'codex',installed:true}]});mount();await waitFor(()=>expect(query.getQueryData(['ai-sources','discovery'])).toBeDefined());fireEvent.click(screen.getByRole('radio',{name:/Codex/}));expect(screen.getByRole('combobox',{name:'客户端模型'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'重新探测'}));await waitFor(()=>expect(fetchJSON).toHaveBeenCalledTimes(2));expect(vi.mocked(fetchJSON).mock.calls[1][0]).toBe('/ai-sources?refresh=true');expect(await screen.findByText('已找到 codex 0.166.0')).toBeVisible();
 });
});
