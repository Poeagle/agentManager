import {describe,expect,it} from 'vitest';
import {inferQuiescentSessionState} from '../src/services/session-state.js';

describe('terminal menu selection detection',()=>{
  it('does not mistake numbered Outlook instructions and an inline play icon for an interactive menu',()=>{
    const text='在 Outlook 网页版执行规则：\n1. 打开右上角齿轮 → 邮件 → 规则。\n2. 找到 JIRA 规则。\n3. 点击规则右侧的 ▶「立即运行规则」。\n4. 等待执行完成。\n\n❯ ';
    expect(inferQuiescentSessionState(text)).toMatchObject({processState:'idle',promptType:null,choices:null,isPermission:false});
  });
  it('requires the selection cursor to belong to an actual numbered option',()=>{
    expect(inferQuiescentSessionState('说明：\n1. 第一项。\n2. 第二项。\n❯ ')).toMatchObject({promptType:null});
    expect(inferQuiescentSessionState('选择模型\n│ ❯ 1. Model A │\n│   2. Model B │')).toMatchObject({processState:'waiting_for_input',promptType:'choice',choices:['Model A','Model B'],isPermission:false});
    expect(inferQuiescentSessionState('Do you want to proceed?\n1. Yes\n2. No')).toMatchObject({promptType:'choice',isPermission:true});
    expect(inferQuiescentSessionState('Continue? (y/n)')).toMatchObject({promptType:'confirmation',choices:['Yes','No']});
  });
});
