import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative} from 'node:path';
import {test} from 'node:test';
import {runE2e} from '../run-e2e.mjs';

const modules={
 '':'node_modules/@playwright/test/cli.js',
 server:'node_modules/tsx/dist/cli.mjs',
 dashboard:'node_modules/vite/bin/vite.js',
};
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'agentmanager-e2e-bootstrap-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const install=workspace=>{
  const path=join(directory,workspace,modules[workspace]);
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,'');
 };
 return {directory,install};
}

test('installs missing lockfile dependencies with dev packages and runs the locked browser',t=>{
 const {directory,install}=fixture(t),calls=[];
 const result=runE2e(['e2e/codex-environments.spec.ts'],{directory,execute(_command,args,cwd){
  const workspace=relative(directory,cwd);
  if(args.includes('ci')){
   assert.ok(args.includes('--include=dev'));
   calls.push(`npm:${workspace}`);
   install(workspace);
  }else{
   assert.equal(args[0],join(directory,modules['']));
   calls.push(args.slice(1).join(' '));
  }
  return 0;
 }});
 assert.equal(result,0);
 assert.deepEqual(calls,['npm:','npm:server','npm:dashboard','install chromium','test e2e/codex-environments.spec.ts']);
});

test('lists tests using the local CLI without provisioning a browser or starting servers',t=>{
 const {directory,install}=fixture(t);
 install('');
 const calls=[];
 const result=runE2e(['--list'],{directory,execute(command,args){calls.push([command,...args]);return 0;}});
 assert.equal(result,0);
 assert.deepEqual(calls,[[process.execPath,join(directory,modules['']),'test','--list']]);
});

test('returns dependency installation failures before running Playwright',t=>{
 const {directory}=fixture(t);
 const calls=[];
 const result=runE2e([],{directory,execute(_command,args){calls.push(args);return 17;}});
 assert.equal(result,17);
 assert.equal(calls.length,1);
 assert.ok(calls[0].includes('--include=dev'));
});
