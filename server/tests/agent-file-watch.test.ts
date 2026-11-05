import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {appendFileSync,existsSync,mkdtempSync,mkdirSync,renameSync,rmSync,writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {watchNativeFile} from '../src/services/agents/file-watch.js';
let root:string,stop:()=>void;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'agent-file-watch-'));});
afterEach(()=>{stop?.();rmSync(root,{recursive:true,force:true});});
it('recovers a missing file with backoff, then observes writes without polling',async()=>{
 const path=join(root,'rollout.jsonl'),locate=vi.fn(async()=>existsSync(path)?path:null),changed=vi.fn(),observer=watchNativeFile(locate,changed);stop=observer.stop;
 await vi.waitFor(()=>expect(locate).toHaveBeenCalledOnce());writeFileSync(path,'one\n');
 await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce(),{timeout:1500});const calls=locate.mock.calls.length;
 appendFileSync(path,'two\n');await vi.waitFor(()=>expect(changed.mock.calls.length).toBeGreaterThan(1));
 await new Promise(resolve=>setTimeout(resolve,300));expect(locate).toHaveBeenCalledTimes(calls);
 stop();const count=changed.mock.calls.length;appendFileSync(path,'three\n');await new Promise(resolve=>setTimeout(resolve,100));expect(changed).toHaveBeenCalledTimes(count);
});
it('rebinds after atomic replacement and after its parent directory moves',async()=>{
 const parent=join(root,'sessions'),moved=join(root,'old-sessions');mkdirSync(parent);let path=join(parent,'rollout.jsonl');writeFileSync(path,'one\n');
 const locate=vi.fn(async()=>existsSync(path)?path:null),changed=vi.fn(),observer=watchNativeFile(locate,changed);stop=observer.stop;
 await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce());writeFileSync(join(parent,'new'),'two\n');renameSync(join(parent,'new'),path);
 await vi.waitFor(()=>expect(locate.mock.calls.length).toBeGreaterThan(1));const before=locate.mock.calls.length;
 renameSync(parent,moved);path=join(moved,'rollout.jsonl');
 await vi.waitFor(()=>expect(locate.mock.calls.length).toBeGreaterThan(before),{timeout:1500});const count=changed.mock.calls.length;
 appendFileSync(path,'three\n');await vi.waitFor(()=>expect(changed.mock.calls.length).toBeGreaterThan(count));
});
