import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase } from '../helpers/database.js';
import { getDb } from '../../src/db/index.js';
import { initAccountUsage, collectAccountUsage } from '../../src/services/agents/codex/account-usage.js';
import { aggregateKey, usageAggregates } from '../../src/services/agents/codex/usage-aggregates.js';
import { exportUsageCsv } from '../../src/services/agents/codex/usage-csv-export.js';

const fixture = createTestDatabase();
try {
  process.env.TZ = 'UTC';
  process.env.CODEX_HOME = join(fixture.dir, 'codex');
  const home = process.env.CODEX_HOME;
  const dir = join(home, 'sessions');
  mkdirSync(dir, { recursive: true });
  const nativeId = '019ff001-1111-7111-8111-111111111111';
  const target = join(dir, `rollout-${nativeId}.jsonl`);
  const date = new Date().toISOString().slice(0, 10);
  const detailCount = Number(process.argv[2] || 338824);
  if (!Number.isSafeInteger(detailCount) || detailCount < 160 || detailCount > 1999995) {
    throw Error('Expected an integer number of prior usage records from 160 to 1999995');
  }
  const model = 'gpt-5';
  const tokens = { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 2, total_tokens: 120 };
  const receipt = (id: string, timestamp: string) => JSON.stringify({ type: 'token_usage_record', timestamp, payload: { response_id: id, usage: tokens } }) + '\n';
  const responseId = (i: number) => `receipt-${i}`;
  const iso = (day: string, seconds: number) => `${day}T12:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`;
  const log = (i: number) => receipt(responseId(i), iso(date, i));
  const output = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(59000) } }) + '\n';
  writeFileSync(target, JSON.stringify({type:'session_meta',payload:{id:nativeId,cwd:'/sample',model}})+'\n' +
    Array.from({ length: 160 }, (_, index) => log(index) + output).join(''));
  initAccountUsage();
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO codex_usage_sources VALUES(?,?)').run('native', JSON.stringify(['native', home]));
    db.prepare('INSERT INTO codex_usage_snapshots VALUES(?,1)').run('native');
    db.prepare('INSERT INTO codex_usage_ledger(account,baseline_at,last_day,timezone) VALUES(?,NULL,?,?)').run('native', date, 'UTC');
    db.prepare('INSERT INTO codex_usage_status VALUES(?,?,NULL,0)').run('native', `${date}T13:00:00Z`);
    db.prepare('INSERT INTO codex_usage_dedup_status(account,ready,hour_backfilled) VALUES(?,1,1)').run('native');
    const identities = db.prepare("INSERT INTO codex_usage_event_ids(account,event_id,day,timezone) VALUES('native',?,?,'UTC')");
    const detail = db.prepare("INSERT INTO codex_usage_dedup_events(account,event_key,day,cwd,model,tier,provider,tokens,hour,at) VALUES('native',?,?,?, ?,NULL,NULL,?,?,?)");
    const aggregate = db.prepare("INSERT INTO codex_usage_events VALUES('native',?,?,?,?,NULL,?)");
    const counts = new Map<string, number>();
    const encoded = JSON.stringify({ ...tokens, _timezone: 'UTC' });
    for (let i = 0; i < detailCount; i++) {
      const day = i < 160 ? date : new Date(Date.parse(date) - 86400000 * (1 + Math.floor((i - 160) / 2000))).toISOString().slice(0, 10);
      const hour = `${day}T12:00:00+00:00`;
      const key = createHash('sha256').update(JSON.stringify(['request', responseId(i)])).digest();
      identities.run(key, day);
      detail.run(key.toString('hex'), day, '/sample', model, encoded, hour, iso(day, i % 2000));
      counts.set(day, (counts.get(day) || 0) + 1);
    }
    for (const [day, requests] of counts) {
      const counts = Object.fromEntries(Object.entries(tokens).map(([field, n]) => [field, n * requests]));
      aggregate.run(aggregateKey({day, cwd:'/sample',model,tier:null},tokens), day, '/sample', model, JSON.stringify({ ...counts, requests }));
    }
  })();
  exportUsageCsv('native', { rebuild: true });
  // Ordinary account collection creates a file checkpoint from the same fixture.
  await collectAccountUsage('native');
  const measurements: Record<string, number[]> = { alreadyCounted: [], appendedUsage: [] };
  for (let index = 0; index < 5; index++) {
    let start = performance.now();
    await collectAccountUsage('native', { nativeId });
    measurements.alreadyCounted.push(Math.round(performance.now() - start));
    appendFileSync(target,receipt(`new-${index}`,iso(date,200+index)));
    start = performance.now();
    await collectAccountUsage('native', { nativeId });
    measurements.appendedUsage.push(Math.round(performance.now() - start));
  }
  const totals: Record<string, number> = { requests: 0, ...Object.fromEntries(Object.keys(tokens).map(field => [field, 0])) };
  for (const row of usageAggregates('native')) {
    const counted = JSON.parse(row.tokens);
    for (const field of Object.keys(totals)) totals[field] += counted[field];
  }
  const expected: Record<string, number> = { ...tokens, requests: 1 };
  const events = (db.prepare("SELECT count(*) AS count FROM codex_usage_event_ids WHERE account='native'").get() as { count: number }).count;
  if (events !== detailCount + 5 || Object.keys(totals).some(field => totals[field] !== expected[field] * events)) {
    throw Error(`Unexpected usage: ${JSON.stringify({ events, totals })}`);
  }
  console.log(JSON.stringify({ priorRequests: detailCount, measurementsMs: measurements, events, totals }));
} finally {
  fixture.cleanup();
}
