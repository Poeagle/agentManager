import {it,expect} from 'vitest';
import {directoryPath,readDroppedDirectory,packDirectory,type DroppedEntry} from '../src/lib/directory-upload';
const file=(name:string):DroppedEntry=>({name,isDirectory:false,file:done=>done(new File(['value'],name))});
function directory(name:string,batches:DroppedEntry[][]):DroppedEntry{return {name,isDirectory:true,createReader:()=>{let i=0;return {readEntries:done=>done(batches[i++]||[])};}};}
it('reads every directory batch and preserves nested and empty directory paths',async()=>{
 const root=directory('目录',[[file('a.txt')],[directory('sub',[[file('b.txt')]]),directory('empty',[])]]);
 const entries=await readDroppedDirectory(root,new AbortController().signal);
 expect(entries.map(entry=>entry.path)).toEqual(['目录/a.txt','目录/sub/b.txt','目录/empty/']);
});
it('rejects traversal, duplicate paths and cancelled work before starting a compression worker',async()=>{
 for(const path of ['/root/a','C:/secret','dir/../secret','dir//a'])expect(()=>directoryPath(path)).toThrow('无效');
 await expect(packDirectory('dir',[{path:'dir/a/'},{path:'dir/a/'}],new AbortController().signal,()=>{})).rejects.toThrow('重复');
 const controller=new AbortController();controller.abort();await expect(readDroppedDirectory(directory('dir',[]),controller.signal)).rejects.toMatchObject({name:'AbortError'});
});
