import type Database from 'better-sqlite3';
import { tokenFields } from '../../conversation-usage.js';

type Tokens = Record<(typeof tokenFields)[number], number | null>;
type Candidate = {
  key: string;
  alias_key: string | null;
  request_key: string | null;
  day: string;
  cwd: string;
  model: string | null;
  tier: string | null;
  tokens: Tokens;
};
type UsageRow = Pick<Candidate, 'day' | 'cwd' | 'model' | 'tier' | 'tokens'> & { requests: number };
const identity = /^[a-f0-9]{64}$/;

/** Resolve the scanner's native and legacy aliases against the existing ledger.
 * Only identities in this rollout cross the SQLite boundary. */
export function resolveTargetUsage(db: Database.Database, account: string, candidates: Candidate[]) {
  const requested = new Set<string>();
  for (const event of candidates) {
    if (!identity.test(event.key) || event.alias_key !== null && !identity.test(event.alias_key)
      || event.request_key !== null && !identity.test(event.request_key)
      || event.key !== (event.request_key ?? event.alias_key) || !event.tokens
      || tokenFields.some(field => event.tokens[field] !== null && !Number.isSafeInteger(event.tokens[field]))) {
      throw Error('Invalid target usage identities');
    }
    requested.add(event.key);
    if (event.alias_key) requested.add(event.alias_key);
  }
  const known = new Set<string>();
  const ids = [...requested];
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = db.prepare(`SELECT event_id FROM codex_usage_event_ids WHERE account=?
      AND event_id IN (${chunk.map(() => '?').join(',')})`).all(account, ...chunk.map(key => Buffer.from(key, 'hex'))) as { event_id: Buffer }[];
    for (const row of rows) known.add(row.event_id.toString('hex'));
  }

  const added = new Set<string>();
  const groups = new Map<string, UsageRow>();
  const dayKeys = new Map<string, Buffer[]>();
  const events = [];
  for (const { alias_key: alias, ...event } of candidates) {
    // Alias choice uses the ledger at the start of the scan. A duplicate
    // encountered later within this rollout must not change that choice.
    const key = event.request_key && alias && known.has(alias) && !known.has(event.request_key) ? alias : event.key;
    if (known.has(key) || added.has(key)) continue;
    added.add(key);
    events.push({ ...event, key });
    const keys = dayKeys.get(event.day) ?? [];
    if (!dayKeys.has(event.day)) dayKeys.set(event.day, keys);
    keys.push(Buffer.from(key, 'hex'));
    const groupKey = JSON.stringify([event.day, event.cwd, event.model, event.tier, tokenFields.map(field => event.tokens[field] !== null)]);
    const row = groups.get(groupKey);
    if (!row) {
      groups.set(groupKey, { day: event.day, cwd: event.cwd, model: event.model, tier: event.tier, requests: 1, tokens: { ...event.tokens } });
    } else {
      row.requests++;
      for (const field of tokenFields) {
        const previous = row.tokens[field], next = event.tokens[field];
        const total = previous === null || next === null ? null : previous + next;
        // The original scanner adds Python integers before JSON serialization.
        if (total !== null && !Number.isSafeInteger(total)) return null;
        row.tokens[field] = total;
      }
    }
  }
  return {
    events, rows: [...groups.values()],
    event_keys: Object.fromEntries([...dayKeys].map(([day, keys]) => [day, Buffer.concat(keys).toString('base64')])),
  };
}
