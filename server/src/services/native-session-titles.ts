import {broadcastEphemeral} from './event-store.js';
import {getDb} from '../db/index.js';
export function initNativeSessionTitles(){getDb().exec('CREATE TABLE IF NOT EXISTS session_native_titles(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,title TEXT NOT NULL)');}
export function saveNativeSessionTitle(sessionId:string,value:unknown){
 if(typeof value!=='string')return;const title=value.trim().replace(/[\r\n\t]+/g,' ').slice(0,160);if(!title)return;initNativeSessionTitles();const result=getDb().prepare('INSERT INTO session_native_titles(session_id,title) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET title=excluded.title WHERE title<>excluded.title').run(sessionId,title);
 if(result.changes){const session=getDb().prepare('SELECT project_id FROM sessions WHERE id=?').get(sessionId) as {project_id:string|null}|undefined;broadcastEphemeral({type:'session.title',session_id:sessionId,...session?.project_id?{project_id:session.project_id}:{},data:{title}});}
}
export function nativeSessionTitle(sessionId:string){
 if(!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_native_titles'").get())return null;
 return (getDb().prepare('SELECT title FROM session_native_titles WHERE session_id=?').get(sessionId) as {title:string}|undefined)?.title??null;
}
