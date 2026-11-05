import {purgeExpiredAuthSessions} from '../auth.js';
export const AUTH_SESSION_CLEANUP_INTERVAL_MS=60*60*1000;
/** One sweep at server readiness, then hourly. This touches authentication
 * credentials only, never Agent sessions, terminal workers or their history. */
export function startAuthSessionCleanup(onError:(error:unknown)=>void):()=>void {
 const sweep=()=>{try{purgeExpiredAuthSessions();}catch(error){onError(error);}};
 sweep();const timer=setInterval(sweep,AUTH_SESSION_CLEANUP_INTERVAL_MS);timer.unref?.();
 return ()=>clearInterval(timer);
}
