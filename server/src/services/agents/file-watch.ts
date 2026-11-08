import {watch,type FSWatcher} from 'fs';
import {basename,dirname} from 'path';
/** Recover only while missing/broken. A healthy observer has no polling timer. */
export function watchNativeFile(locate:()=>Promise<string|null>,changed:()=>void){
 let closed=false,locating=false,observer:FSWatcher|undefined,parentObserver:FSWatcher|undefined,timer:ReturnType<typeof setTimeout>|undefined,attempt=0;
 function schedule(){if(closed||timer)return;timer=setTimeout(()=>{timer=undefined;void attach();},Math.min(10000,250*2**Math.min(attempt++,6)));timer.unref?.();}
 function reset(){const old=observer,parent=parentObserver;observer=undefined;parentObserver=undefined;old?.close();parent?.close();schedule();}
 async function attach(){if(closed||observer||locating)return;locating=true;
  try{const path=await locate();if(closed)return;if(!path){schedule();return;}
   const directory=dirname(path),parentDirectory=dirname(directory);
   const current=watch(directory,{persistent:false},(event,name)=>{if(!name||name.toString()===basename(path)){changed();if(event==='rename')reset();}});
   let parent:FSWatcher;
   try{parent=watch(parentDirectory,{persistent:false},(event,name)=>{if(event==='rename'&&(!name||name.toString()===basename(directory)))reset();});}
   catch(error){current.close();throw error;}
   observer=current;parentObserver=parent;attempt=0;
   current.on('error',()=>{if(observer===current)reset();});current.on('close',()=>{if(observer===current)reset();});
   parent.on('error',()=>{if(parentObserver===parent)reset();});parent.on('close',()=>{if(parentObserver===parent)reset();});
   changed();
  }catch{schedule();}finally{locating=false;}
 }
 void attach();
 return {poke(){if(closed||observer)return;clearTimeout(timer);timer=undefined;void attach();},stop(){closed=true;clearTimeout(timer);const current=observer,parent=parentObserver;observer=undefined;parentObserver=undefined;current?.close();parent?.close();}};
}
