import {describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import * as pty from 'node-pty-prebuilt-multiarch';
import {sessionEnvironment,tmuxClientArgs} from '../src/lib/terminal-environment.js';

describe('UTF-8 browser terminal transport',()=>{
 it('defaults missing service locales per platform and retains explicit locales without forwarding server settings',()=>{
  expect(sessionEnvironment({PATH:'/bin',PORT:'secret',NODE_ENV:'production'},'darwin')).toMatchObject({LANG:'en_US.UTF-8',TERM:'xterm-256color'});
  expect(sessionEnvironment({},'linux').LANG).toBe('C.UTF-8');
  const explicit=sessionEnvironment({LANG:'zh_TW.UTF-8',LC_ALL:'C',LC_CTYPE:'en_US.UTF-8',PORT:'secret'},'darwin');
  expect(explicit).toMatchObject({LANG:'zh_TW.UTF-8',LC_ALL:'C',LC_CTYPE:'en_US.UTF-8'});expect(explicit).not.toHaveProperty('PORT');expect(explicit).not.toHaveProperty('NODE_ENV');
 });
 const hasTmux=(()=>{try{execFileSync('tmux',['-V'],{stdio:'ignore'});return true;}catch{return false;}})();
 it.skipIf(!hasTmux)('keeps Chinese and box glyphs through a real tmux client under the C locale',async()=>{
  const server=`am-utf8-test-${process.pid}`,env={...process.env,LANG:'C',LC_ALL:'C',LC_CTYPE:'C',TERM:'xterm-256color'},text='中文测试 ╭──╮ ✓';
  let terminal:pty.IPty|undefined;
  try{
   execFileSync('tmux',[...tmuxClientArgs(server),'-f','/dev/null','new-session','-d','-s','encoding','-x','100','-y','12','/bin/sh','-c',`printf '${text}\\n'; exec sleep 20`],{env});
   let received='';
   await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('tmux did not deliver the UTF-8 probe')),3000);
    terminal=pty.spawn('tmux',[...tmuxClientArgs(server),'attach-session','-t','encoding'],{name:'xterm-256color',cols:100,rows:12,env});
    terminal.onData(data=>{received+=data;if(received.includes(text)){clearTimeout(timeout);resolve();}});
   });
   expect(received).toContain(text);expect(received).not.toContain('________');
  }finally{
   try{execFileSync('tmux',[...tmuxClientArgs(server),'kill-server'],{stdio:'ignore'});}catch{}
   try{terminal?.kill();}catch{}
  }
 });
});
