import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {config} from '../src/config.js';
import {initAccountUsage,cachedAccountUsage,cachedGroupUsage,USAGE_RULE_VERSION} from '../src/services/agents/codex/account-usage.js';
import {publishUsageCsv,usageCsvDirectory} from '../src/services/agents/codex/usage-csv.js';
let fixture:ReturnType<typeof createTestDatabase>;
beforeEach(()=>{vi.stubEnv('TZ','UTC');fixture=createTestDatabase();initAccountUsage();const db=getDb();db.prepare('INSERT INTO codex_usage_status VALUES(?,?,NULL,0)').run('native','2026-11-14T08:00:00Z');db.prepare('INSERT INTO codex_usage_ledger(account,last_day,timezone) VALUES(?,?,?)').run('native','2026-11-14','UTC');db.prepare('INSERT INTO codex_usage_snapshots VALUES(?,1)').run('native');db.prepare('INSERT INTO codex_usage_dedup_status(account,ready) VALUES(?,1)').run('native');db.prepare("INSERT INTO codex_usage_rule_versions(account,version,state) VALUES(?,?,'ready')").run('native',USAGE_RULE_VERSION);});
afterEach(()=>{fixture.cleanup();vi.unstubAllEnvs();});
it('reports database fallback before a matching CSV generation is available',()=>{expect(cachedAccountUsage('native').storage).toEqual({kind:'database',path:config.dbPath});});
it('reports CSV only when that generation is actually used for the daily or hourly read',()=>{publishUsageCsv('native',{day:'2026-11-14',timezone:'UTC',checkpoint:'2026-11-14T08:00:00Z',current:[],history:[],quota:[]});expect(cachedAccountUsage('native').storage).toEqual({kind:'csv',path:usageCsvDirectory('native')});expect(cachedGroupUsage(['native'],'hour',true).storage).toEqual({kind:'csv',path:usageCsvDirectory('native')});getDb().prepare('UPDATE codex_usage_status SET partial=1').run();expect(cachedAccountUsage('native').storage.kind).toBe('csv');getDb().prepare('UPDATE codex_usage_status SET checked_at=?').run('2026-11-14T08:05:00Z');expect(cachedAccountUsage('native').storage).toEqual({kind:'database',path:config.dbPath});});

it('falls back to the database when a published CSV file is damaged',()=>{publishUsageCsv('native',{day:'2026-11-14',timezone:'UTC',checkpoint:'2026-11-14T08:00:00Z',current:[],history:[],quota:[]});const root=usageCsvDirectory('native'),manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));writeFileSync(join(root,manifest.files.current),'broken');expect(cachedAccountUsage('native').storage).toEqual({kind:'database',path:config.dbPath});});
