import {describe,expect,it} from 'vitest';
import {render,screen} from '@testing-library/react';
import {sessionAgent,agentNativeId,agentSupports,builtinAgentDescriptors,type AgentDescriptor} from '../src/lib/agents';
import {signalForSession} from '../src/lib/session-signal-model';
import {projectOpenModes} from '../src/components/project-open-modes';
import {ProjectOpenDialog} from '../src/components/ProjectOpenDialog';
import type {Project,Session} from '../src/lib/api';
const provider:AgentDescriptor={id:'third_agent',label:'Third Agent',capabilities:{...builtinAgentDescriptors()[0].capabilities,launch:true,runtime:true,controls:true},presentation:{icon:'generic',color:'#123456'}};
describe('agent capabilities in shared UI',()=>{
 it('uses server metadata and opaque identity for a new provider without rendering it as Claude',()=>{
  const session={id:'third',cli_type:provider.id,agent:provider,native_session_id:'opaque/native:42',agent_runtime:{source:'third_stream',state:'running'}} as Session;
  expect(sessionAgent(session).label).toBe('Third Agent');expect(agentNativeId(session)).toBe('opaque/native:42');expect(agentSupports(session,'controls')).toBe(true);
  expect(signalForSession(session,{})?.title).toBe('Third Agent 运行中 · 原生执行记录');
  const unknown={cli_type:'unregistered',native_session_id:'opaque'};expect(sessionAgent(unknown).label).toBe('unregistered');expect(agentSupports(unknown,'model')).toBe(false);expect(agentNativeId({cli_type:'unregistered',codex_session_id:'old'})).toBeNull();
 });
 it('builds authorized creation choices from the registered provider catalog',()=>{
  const project={id:'p',name:'Plugin project',path:'/project',agent_catalog:[provider],tool_access:{can_session:true,can_terminal:false,session_clients:['third_agent']}} as Project;
  expect(projectOpenModes(project).map(option=>({id:option.id,label:option.label,cli:option.cli}))).toEqual([{id:'third_agent',label:'Third Agent',cli:'third_agent'}]);
  render(<ProjectOpenDialog project={project} onClose={()=>{}} onOpen={()=>{}}/>);expect(screen.getByRole('radio',{name:'Third Agent'})).toBeVisible();expect(screen.queryByText('Claude')).not.toBeInTheDocument();
 });
});
