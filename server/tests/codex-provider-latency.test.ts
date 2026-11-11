import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {createTestDatabase} from './helpers/database.js';
import {updateAgentManagement} from '../src/services/agents/management-store.js';
import {codexManagement} from '../src/services/agents/codex/management.js';
import * as cli from '../src/services/agents/management-cli.js';
vi.mock('../src/services/agents/management-cli.js',async original=>({...await original<typeof import('../src/services/agents/management-cli.js')>(),findExecutable:vi.fn(async()=>'/fixture/codex'),runCli:vi.fn(async()=>({ok:true,stdout:'codex 1.0.0',stderr:'',code:0}))}));
let db:ReturnType<typeof createTestDatabase>,home:string,oldHome:string|undefined;
beforeEach(()=>{db=createTestDatabase();oldHome=process.env.CODEX_HOME;home=mkdtempSync(join(tmpdir(),'provider-latency-'));process.env.CODEX_HOME=home;writeFileSync(join(home,'model-catalog.json'),JSON.stringify({models:[{slug:'m',base_instructions:'fixture',support_verbosity:true,default_verbosity:'low',truncation_policy:{mode:'tokens',limit:1}}]}));updateAgentManagement('codex',()=>({defaults:{},providers:[{id:'fixture',name:'Fixture',kind:'responses',enabled:false,fields:{baseUrl:'https://example.invalid/v1',models:['m'],codexHome:home}}]}));});
afterEach(()=>{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;rmSync(home,{recursive:true,force:true});db.cleanup();vi.clearAllMocks();});
it('does not run full Codex doctor after saving a Provider',async()=>{
 const management=codexManagement({id:'codex',label:'Codex'} as any);
 await management.updateProvider('fixture',{fields:{baseUrl:'https://example.invalid/v1'}});
 expect(vi.mocked(cli.runCli).mock.calls.some(([,args])=>args.includes('doctor'))).toBe(false);
});
