import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,readFileSync,readdirSync,symlinkSync,utimesSync,writeFileSync} from 'fs';
import {join} from 'path';
import {execFileSync} from 'child_process';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {attachmentStorageRoot,isProjectAttachment,projectAttachmentDirectory} from '../src/services/attachment-storage.js';
import {sweepAllPastes} from '../src/services/paste-cleanup.js';

let fixture:ReturnType<typeof createTestDatabase>,project:string;
beforeEach(()=>{
  fixture=createTestDatabase();project=join(fixture.dir,'project');mkdirSync(project);
  getDb().prepare("INSERT INTO projects(id,name,path) VALUES('p','P',?)").run(project);
});
afterEach(()=>{vi.unstubAllEnvs();fixture.cleanup();});

describe('external attachment storage',()=>{
  it('refuses configured storage within any registered project before creating it',()=>{
    vi.stubEnv('AGENTMANAGER_ATTACHMENTS_DIR',join(project,'data','attachments'));
    expect(()=>projectAttachmentDirectory(project,true)).toThrow('不能位于项目内');
    expect(readdirSync(project)).toEqual([]);
  });
  it.each(['directory','worktree','symlink'])('refuses storage inside a Git %s before writing',kind=>{
    const repo=join(fixture.dir,'repo');mkdirSync(repo);
    if(kind==='worktree')writeFileSync(join(repo,'.git'),'gitdir: /elsewhere');
    else execFileSync('git',['init','--quiet',repo]);
    const path=join(repo,'data','attachments');
    if(kind==='symlink')symlinkSync(repo,join(fixture.dir,'alias'));
    vi.stubEnv('AGENTMANAGER_ATTACHMENTS_DIR',kind==='symlink'?join(fixture.dir,'alias','data','attachments'):path);
    expect(()=>projectAttachmentDirectory(project,true)).toThrow('不能位于 Git 仓库内');
    expect(readdirSync(repo)).toEqual(['.git']);
  });
  it('rejects symlinked project storage and files pointing into another project',()=>{
    const other=join(fixture.dir,'other');mkdirSync(other);
    const own=projectAttachmentDirectory(project,true),foreign=projectAttachmentDirectory(other,true);
    const path=join(foreign,'paste-other.txt');writeFileSync(path,'private');
    symlinkSync(path,join(own,'paste-link.txt'));
    expect(isProjectAttachment(join(own,'paste-link.txt'),project)).toBe(false);
    vi.stubEnv('AGENTMANAGER_ATTACHMENTS_DIR',join(fixture.dir,'redirected'));
    const destination=projectAttachmentDirectory(project);mkdirSync(attachmentStorageRoot());
    const key=destination.split('/').at(-2)!;symlinkSync(foreign,join(attachmentStorageRoot(),key));
    expect(()=>projectAttachmentDirectory(project,true)).toThrow('符号链接');
  });
  it('rejects a project or Git repository nested under the configured storage root',()=>{
    const directory=projectAttachmentDirectory(project);
    mkdirSync(directory,{recursive:true});
    getDb().prepare("INSERT INTO projects(id,name,path) VALUES('nested','Nested',?)").run(directory);
    expect(()=>projectAttachmentDirectory(project,true)).toThrow('不能位于项目内');
    getDb().prepare("DELETE FROM projects WHERE id='nested'").run();
    execFileSync('git',['init','--quiet',directory]);
    expect(()=>projectAttachmentDirectory(project,true)).toThrow('不能位于 Git 仓库内');
    expect(readdirSync(directory)).toEqual(['.git']);
  });
  it('keeps existing project-local attachments readable and never sweeps them',()=>{
    const old=join(project,'.agentmanager','pastes');mkdirSync(old,{recursive:true});
    const path=join(old,'paste-old.txt');writeFileSync(path,'old history');
    const date=new Date(Date.now()-8*24*60*60*1000);utimesSync(path,date,date);
    const external=projectAttachmentDirectory(project,true),expired=join(external,'paste-expired.txt');
    writeFileSync(expired,'expired');utimesSync(expired,date,date);
    expect(isProjectAttachment(path,project,true)).toBe(true);
    expect(isProjectAttachment(path,project)).toBe(false);
    sweepAllPastes();
    expect(readFileSync(path,'utf8')).toBe('old history');expect(existsSync(expired)).toBe(false);
  });
});
