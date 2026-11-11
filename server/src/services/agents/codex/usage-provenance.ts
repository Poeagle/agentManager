import {getDb} from '../../../db/index.js';

export function initUsageProvenance(){getDb().exec('CREATE TABLE IF NOT EXISTS codex_usage_origins(account TEXT NOT NULL,thread_id TEXT NOT NULL,imported INTEGER NOT NULL,after_at TEXT,PRIMARY KEY(account,thread_id))');}
/** Imported ancestors remain native history, but are never target consumption. */
export function recordUsageImports(account:string,ids:string[]){
 initUsageProvenance();const insert=getDb().prepare('INSERT OR IGNORE INTO codex_usage_origins VALUES(?,?,1,NULL)');getDb().transaction(()=>{for(const id of ids)insert.run(account,id);})();
}
export function recordUsageFork(account:string,id:string,after:string){
 initUsageProvenance();getDb().prepare('INSERT OR IGNORE INTO codex_usage_origins VALUES(?,?,0,?)').run(account,id,after);
}
export function usageOrigins(account:string){
 const rows=getDb().prepare('SELECT thread_id,imported,after_at FROM codex_usage_origins WHERE account=? LIMIT 20001').all(account) as {thread_id:string;imported:number;after_at:string|null}[];
 if(rows.length>20000)throw Error('Usage origin limit exceeded');
 return Object.fromEntries(rows.map(row=>[row.thread_id,row.imported?{exclude:true}:{after:row.after_at}]));
}
