import {describe,expect,it} from 'vitest';
import {droppedFiles,safeUploadPath} from '../src/lib/file-upload';
function directory(name:string,pages:unknown[][]):unknown {
  return {name,isDirectory:true,isFile:false,createReader:()=>{let index=0;return {readEntries:(done:(entries:unknown[])=>void)=>done(pages[index++] || [])};}};
}
describe('recursive folder drops',()=>{
  it('drains all directory-reader pages and retains empty folders',async()=>{
    const file=new File(['abc'],'note.txt');
    const child={name:'note.txt',isDirectory:false,isFile:true,file:(done:(file:File)=>void)=>done(file)};
    const root=directory('资料',[[child],[directory('empty',[])]]);
    const request=droppedFiles({files:[],items:[{webkitGetAsEntry:()=>root}]} as unknown as DataTransfer);
    const tree=await request.tree;
    expect(tree?.directories).toEqual(['资料','资料/empty']);
    expect(tree?.files).toEqual([{file,relativePath:'资料/note.txt'}]);
  });
  it.each(['../x','/x','a/../x','a\\x','a//x'])('rejects unsafe relative paths %s',path=>expect(()=>safeUploadPath(path)).toThrow());
});
