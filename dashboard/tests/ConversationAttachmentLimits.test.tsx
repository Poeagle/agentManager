import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';

import {useConversationAttachments} from '../src/lib/use-conversation-attachments';
import {api} from '../src/lib/api';
import {packDirectory} from '../src/lib/directory-upload';

vi.mock('../src/lib/directory-upload',async()=>({...await vi.importActual('../src/lib/directory-upload'),packDirectory:vi.fn()}));
function file(name:string,size:number,type='application/zip'){
  const value=new File(['content'],name,{type});
  Object.defineProperty(value,'size',{value:size});
  return value;
}
beforeEach(()=>{
  vi.spyOn(api.sessions,'pasteFile').mockImplementation(async(_id,_data,name)=>({path:'/project/.agentmanager/pastes/'+name}));
  vi.spyOn(api.sessions,'pasteImage').mockResolvedValue({path:'/project/.agentmanager/pastes/image.png'});
});

it('uploads a file at 100 MB and rejects an additional file above the total budget',async()=>{
  const {result}=renderHook(()=>useConversationAttachments('limit-file'));
  act(()=>result.current.enqueue([file('large.zip',100*1024*1024)]));
  await waitFor(()=>expect(result.current.items[0]?.status).toBe('ready'));
  expect(api.sessions.pasteFile).toHaveBeenCalledOnce();expect(result.current.error).toBe('');
  act(()=>result.current.enqueue([file('extra.zip',1)]));
  expect(result.current.items).toHaveLength(1);expect(result.current.error).toContain('附件合计最多 100 MB');
});

it('rejects a file one byte over 100 MB before reading or uploading it',()=>{
  const {result}=renderHook(()=>useConversationAttachments('limit-oversized'));
  act(()=>result.current.enqueue([file('oversized.zip',100*1024*1024+1)]));
  expect(result.current.items).toHaveLength(0);expect(result.current.error).toContain('单个文件最多 100 MB');
  expect(api.sessions.pasteFile).not.toHaveBeenCalled();
});

it('keeps the image budget at 10 MB',()=>{
  const {result}=renderHook(()=>useConversationAttachments('limit-image'));
  act(()=>result.current.enqueue([file('large.png',10*1024*1024+1,'image/png')]));
  expect(result.current.items).toHaveLength(0);expect(result.current.error).toContain('图片总大小最多 10 MB');
  expect(api.sessions.pasteImage).not.toHaveBeenCalled();
});

it.each([100*1024*1024,100*1024*1024+1])('checks the packed ZIP size at %s bytes',async size=>{
  vi.mocked(packDirectory).mockResolvedValue(file('data.zip',size));
  const source=file('source.txt',10,'text/plain');Object.defineProperty(source,'webkitRelativePath',{value:'data/source.txt'});
  const {result}=renderHook(()=>useConversationAttachments('limit-directory'));
  act(()=>result.current.enqueue([source]));
  await waitFor(()=>expect(result.current.items[0]?.status).toBe(size===100*1024*1024?'ready':'error'));
  expect(api.sessions.pasteFile).toHaveBeenCalledTimes(size===100*1024*1024?1:0);
});
