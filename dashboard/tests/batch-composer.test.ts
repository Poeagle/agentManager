import {beforeEach,expect,it,vi} from 'vitest';
import {combinedBatch,composerKey,emptyComposer,loadComposer,saveComposer} from '../src/lib/batch-composer';
beforeEach(()=>localStorage.clear());
it('keeps users and sessions separate and restores synchronously',()=>{
 const key=composerKey('a','one'),value={...emptyComposer(),mode:'batch' as const,draft:'typing',entries:[{id:'entry',text:'staged',attachments:[]}]};
 saveComposer(key,value);expect(loadComposer(key)).toEqual(value);
 expect(loadComposer(composerKey('b','one')).entries).toEqual([]);expect(loadComposer(composerKey('a','two')).draft).toBe('');
});
it('rebases attachment offsets when joining staged messages',()=>{
 expect(combinedBatch([{id:'1',text:'abc',attachments:[]},{id:'2',text:'def',attachments:[{kind:'file',name:'a',path:'/fixture/a',offset:1}]}])).toEqual({text:'abc\n\ndef',attachments:[{kind:'file',name:'a',path:'/fixture/a',offset:6}]});
});
it('reports corrupt storage instead of silently replacing it',()=>{
 const key=composerKey('a','one');localStorage.setItem(key,'broken');expect(()=>loadComposer(key)).toThrow();expect(localStorage.getItem(key)).toBe('broken');
});
it('surfaces storage failures to the caller before content is discarded',()=>{
 const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});
 try{expect(()=>saveComposer('key',emptyComposer())).toThrow('quota');}finally{spy.mockRestore();}
});
