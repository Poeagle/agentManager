import {agentDescriptors,getAgent} from './index.js';

const INTERVAL_MS=60*60*1000;
let timer:NodeJS.Timeout|undefined;
let stopped=false;
let running:Promise<void>|undefined;

async function refresh(){
 for(const descriptor of agentDescriptors()){
  if(stopped)return;
  try{await getAgent(descriptor.id).management.refreshProviderBilling?.();}catch{/* A failed provider keeps its last validated rate snapshot. */}
 }
}

export function startProviderBillingSync(){
 if(timer)return;stopped=false;
 const tick=async()=>{
  running=refresh();await running;running=undefined;
  if(!stopped)timer=setTimeout(()=>{void tick();},INTERVAL_MS).unref();
 };
 void tick();
}

export async function stopProviderBillingSync(){
 stopped=true;if(timer)clearTimeout(timer);timer=undefined;await running;
}
