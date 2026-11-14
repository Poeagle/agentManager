import {afterEach,beforeEach,expect,it} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {closeDb,getDb,initDb} from '../src/db/index.js';
import {validateBatch,rememberBatch,decorateBatches} from '../src/services/conversation-batches.js';
let cleanup:()=>void;
beforeEach(()=>{({cleanup}=createTestDatabase());getDb().prepare("INSERT INTO sessions(id,task,status) VALUES('s','fixture','running'),('other','fixture','running')").run();});
afterEach(()=>cleanup());
it('keeps the exact parts after reopening SQLite and isolates identities',()=>{
 const parts=validateBatch([{length:2,attachments:0},{length:1,attachments:0}],'😀\n\nx',[])!;
 rememberBatch('s','client',parts);closeDb();initDb();
 const message={id:'native',client_id:'client',text:'😀\n\nx',role:'user' as const,timestamp:null};
 expect(decorateBatches('s',[message])[0].batch).toEqual(parts);
 expect(decorateBatches('other',[{...message,batch:parts}])[0].batch).toBeUndefined();
 expect(decorateBatches('s',[{...message,client_id:undefined}])[0].batch).toEqual(parts);
 expect(()=>rememberBatch('s','client',[{text:'different',attachments:[]}])).toThrow('identity');
});
it('rejects missing, overlong, fractional and mismatched boundaries',()=>{
 for(const segments of [[],[{length:-1,attachments:0}],[{length:1.5,attachments:0}],[{length:10,attachments:0}],Array(101).fill({length:0,attachments:0})])expect(()=>validateBatch(segments,'text',[])).toThrow();
 expect(()=>validateBatch([{length:1,attachments:1}],'x',[])).toThrow();
});
it('preserves image-only entries and local attachment offsets',()=>{
 const attachment={kind:'image' as const,name:'fixture',path:'/fixture/image',offset:0};
 expect(validateBatch([{length:0,attachments:1},{length:1,attachments:0}],'\n\nx',[attachment])).toEqual([{text:'',attachments:[attachment]},{text:'x',attachments:[]}]);
 expect(()=>validateBatch([{length:1,attachments:1},{length:1,attachments:0}],'x\n\ny',[{...attachment,offset:4}])).toThrow();
});
