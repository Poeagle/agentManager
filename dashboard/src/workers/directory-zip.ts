import {Zip,ZipDeflate} from 'fflate';
const scope=self as unknown as {onmessage:((event:MessageEvent<Array<{path:string;data:ArrayBuffer}>>)=>void)|null;postMessage:(data:unknown,transfer?:Transferable[])=>void};
scope.onmessage=event=>{
 try{
  const chunks:Uint8Array[]=[];let size=0,last=-1;
  const zip=new Zip((error,chunk,final)=>{
   if(error)throw error;size+=chunk.length;if(size>100*1024*1024)throw Error('打包后的 ZIP 超过 100 MB，请缩小目录范围');chunks.push(chunk);
   if(final){const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}scope.postMessage({data},[data.buffer]);}
  });
  for(const [index,entry] of event.data.entries()){
   const file=new ZipDeflate(entry.path,{level:1});zip.add(file);file.push(new Uint8Array(entry.data),true);
   const progress=Math.floor((index+1)*100/event.data.length);if(progress!==last){scope.postMessage({progress});last=progress;}
  }
  zip.end();
 }catch(error){scope.postMessage({error:error instanceof Error?error.message:'目录打包失败'});}
};
