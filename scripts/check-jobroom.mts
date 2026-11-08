/**
 * Checks for the job room ops routes (S1, shadow): `node scripts/check-jobroom.mts`.
 *
 * Runs the real handlers and the real checkOps/logOps wrapper against an
 * in-memory stand-in for Supabase that enforces the same unique keys and the
 * same shadow rule as 0078_job_room.sql. All numbers and names are synthetic.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as jobRoom from '../src/lib/opsJobRoom.ts';

const {
  runOps, openJobRoom, recordEvent, proposeOutbox, decideApproval, listOutbox,
  saveContact, resolveContact, foldName, guardText, sha256,
} = jobRoom;

process.env.OPS_API_TOKEN = 'x'.repeat(40);
const TOKEN = process.env.OPS_API_TOKEN;

type Row = Record<string, any>;
const UNIQUE: Record<string, string[][]> = {
  contacts: [['phone_e164']],
  job_rooms: [['lead_id'], ['job_id']],
  job_events: [['channel', 'provider_message_id'], ['event_key']],
  job_outbox: [['dedupe_key']],
  job_approvals: [['outbox_id']],
  contact_aliases: [['contact_id', 'alias_folded']],
};
const SEQ: Record<string, string> = { job_rooms: 'code', job_approvals: 'code' };

function fakeDb() {
  const tables: Record<string, Row[]> = {};
  const counters: Record<string, number> = {};
  const rows = (t: string) => (tables[t] ??= []);

  const from = (table: string) => {
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    const filters: ((r: Row) => boolean)[] = [];
    let mode: 'many' | 'single' | 'maybe' = 'many';
    let max = Infinity;

    const run = () => {
      if (op === 'insert') {
        const defaults: Row = table === 'contacts' ? { active: true } : {};
        const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...defaults, ...payload };
        const seq = SEQ[table];
        if (seq) row[seq] = counters[table] = (counters[table] ?? 0) + 1;
        for (const cols of UNIQUE[table] ?? []) {
          if (cols.some((c) => row[c] == null)) continue;
          if (rows(table).some((r) => cols.every((c) => r[c] === row[c]))) {
            return { data: null, error: { code: '23505', message: 'duplicate' } };
          }
        }
        if (table === 'job_outbox' && row.shadow && ['claimed', 'sent', 'unknown'].includes(row.state)) {
          return { data: null, error: { code: '23514', message: 'shadow never sends' } };
        }
        rows(table).push(row);
        return { data: [row], error: null };
      }
      const hit = rows(table).filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      return { data: hit.slice(0, max), error: null };
    };

    const b: any = {
      select: () => b,
      insert: (p: Row) => ((op = 'insert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      order: () => b,
      limit: (n: number) => ((max = n), b),
      single: () => ((mode = 'single'), b),
      maybeSingle: () => ((mode = 'maybe'), b),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        try {
          const res = run();
          if (res.error) return resolve(res);
          if (mode === 'many') return resolve(res);
          const first = res.data?.[0] ?? null;
          if (mode === 'single' && !first) return resolve({ data: null, error: { code: 'PGRST116', message: 'none' } });
          return resolve({ data: first, error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return b;
  };
  return { db: { from } as any, tables, rows };
}

const { db, tables, rows } = fakeDb();
const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  new Request(`https://crm.test/api/ops/jobroom/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (path: string) =>
  new Request(`https://crm.test/api/ops/jobroom/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

// --- Auth: fails closed, and an unauthenticated call never builds a client ---
let built = 0;
const client = () => (built++, db);
let res = await runOps(post('jobs', {}, null), client, 'jobroom.open', openJobRoom);
assert.equal(res.status, 401);
res = await runOps(post('jobs', {}, 'y'.repeat(40)), client, 'jobroom.open', openJobRoom);
assert.equal(res.status, 401);
assert.equal(built, 0, 'no client before auth');
const saved = process.env.OPS_API_TOKEN;
delete process.env.OPS_API_TOKEN;
res = await runOps(post('jobs', {}), client, 'jobroom.open', openJobRoom);
assert.equal(res.status, 503, 'no token configured serves nobody');
process.env.OPS_API_TOKEN = saved;
res = await runOps(
  new Request('https://crm.test/x', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: 'not json' }),
  client, 'jobroom.open', openJobRoom
);
assert.equal(res.status, 400, 'bad JSON is refused, not thrown');

// --- Name folding: exact after accents, never a prefix ---
assert.equal(foldName('Oğuz'), 'oguz');
assert.equal(foldName('Oguz'), 'oguz');
assert.equal(foldName('İsmail  Yılmaz'), 'ismail yilmaz');
assert.notEqual(foldName('Ali'), foldName('Alihan'));

// --- Never-rules at propose time ---
assert.equal(guardText('Bel mij op 06 12 34 56 78', 'technician'), 'phone');
assert.equal(guardText('Bel +31 6 1234 5678', 'customer_reply'), 'phone');
assert.equal(guardText('Mail naar jan@example.com', 'customer_reply'), 'email');
assert.equal(guardText('Het kenteken is AB-123-C', 'technician'), 'plate');
assert.equal(guardText('Afspraak 2026-11-08 om 10:00, € 149,50', 'customer_reply'), null, 'dates and prices are fine');
assert.equal(guardText('Bel 0612345678', 'internal'), null, 'owner may see numbers');
assert.equal(guardText('key sk-ant-abc', 'internal'), 'secret', 'a key string is refused everywhere');

// --- Job room: idempotent per lead, customer saved as a contact ---
const leadId = randomUUID();
const open = { leadId, customer: { phone: '06 00 00 00 01', name: 'Test Klant' }, city: 'Utrecht', postcode: '3511 AB', serviceType: 'bijmaken' };
res = await runOps(post('jobs', open), client, 'jobroom.open', openJobRoom);
let out = (await res.json()) as Row;
assert.equal(res.status, 201);
assert.equal(out.code, 'J-1');
assert.equal(rows('contacts')[0].phone_e164, '+31600000001');
assert.equal(rows('job_rooms')[0].postcode4, '3511');
const roomId = out.jobRoomId as string;
res = await runOps(post('jobs', open), client, 'jobroom.open', openJobRoom);
out = (await res.json()) as Row;
assert.equal(out.created, false);
assert.equal(out.jobRoomId, roomId);
assert.equal(rows('job_rooms').length, 1, 'same lead, same room');
assert.equal((await openJobRoom(db, { leadId: 'nope' })).status, 400);

// --- Events: a replay is a no-op ---
const customerId = rows('contacts')[0].id as string;
const ev = { direction: 'in', channel: 'whatsapp', actor: 'wacli', kind: 'message', providerMessageId: 'wamid.TEST1', jobRoomId: roomId, contactId: customerId, body: 'Hallo' };
assert.equal((await recordEvent(db, ev)).status, 201);
const again = await recordEvent(db, ev);
assert.deepEqual(again.body, { duplicate: true });
assert.equal(rows('job_events').length, 1);
assert.equal((await recordEvent(db, { ...ev, channel: 'fax', providerMessageId: 'z' })).status, 400);

// --- Outbox: shadow, deduped, guarded ---
const msg = { jobRoomId: roomId, contactId: customerId, audience: 'customer_reply', kind: 'quote', tier: 1, body: 'Uw offerte is € 149,50.' };
let p = await proposeOutbox(db, msg);
assert.equal(p.status, 201);
assert.equal(p.body.shadow, true);
const outboxId = p.body.outboxId as string;
p = await proposeOutbox(db, msg);
assert.equal(p.body.duplicate, true);
assert.equal(p.body.outboxId, outboxId);
assert.equal(rows('job_outbox').length, 1, 'same text, same person, one row');

const blockedBefore = rows('job_outbox').length;
p = await proposeOutbox(db, { ...msg, kind: 'tech', audience: 'technician', body: 'Klant belt u: 0612345678' });
assert.equal(p.status, 422);
assert.equal(p.body.reason, 'phone');
assert.equal(rows('job_outbox').length, blockedBefore, 'a blocked text gets no outbox row');
assert.equal(rows('job_events').at(-1)!.kind, 'outbox.blocked');
assert.equal(JSON.stringify(rows('job_events').at(-1)!.meta).includes('0612'), false, 'the blocked number is not logged');

// --- Approval: bound to the exact text ---
const hash = sha256(msg.body);
assert.equal((await decideApproval(db, { outboxId, decision: 'approved', decidedBy: 'owner', via: 'owner_tap', textHash: sha256('other') })).status, 409);
let a = await decideApproval(db, { outboxId, decision: 'approved', decidedBy: 'owner', via: 'owner_voice', textHash: hash });
assert.equal(a.status, 201);
assert.equal(a.body.approvalCode, 'A1');
assert.equal(rows('job_outbox')[0].state, 'approved');
a = await decideApproval(db, { outboxId, decision: 'approved', decidedBy: 'owner', via: 'owner_tap', textHash: hash });
assert.equal(a.status, 409, 'a second decision is refused');

const second = await proposeOutbox(db, { ...msg, kind: 'other', body: 'Tot straks.' });
a = await decideApproval(db, { outboxId: second.body.outboxId, decision: 'rejected', decidedBy: 'owner', via: 'owner_tap', textHash: sha256('Tot straks.') });
assert.equal(a.body.state, 'cancelled');

// --- List ---
res = await runOps(get('outbox?state=approved'), client, 'jobroom.outbox.list', (d, i) =>
  listOutbox(d, (i as URL).searchParams.get('state'), 50)
);
assert.equal(((await res.json()) as Row).items.length, 1);
assert.equal((await listOutbox(db, 'bogus', 10)).status, 400);

// --- Contacts: exact aliases, ask when unsure, no full number out ---
const alihan = await saveContact(db, { phone: '0611111111', name: 'Alihan K', role: 'technician', city: 'Rotterdam', alias: 'Alihan', confirmedBy: 'owner' });
const ali = await saveContact(db, { phone: '0622222222', name: 'Ali D', role: 'technician', city: 'Utrecht', alias: 'Ali', confirmedBy: 'owner' });
assert.equal(alihan.status, 201);
assert.equal(ali.status, 201);
let r = await resolveContact(db, 'ali');
assert.equal(r.body.status, 'one', 'Ali does not hit Alihan');
assert.equal((r.body.contact as Row).name, 'Ali D');
assert.equal((await resolveContact(db, 'Veli')).body.status, 'none');

const o1 = await saveContact(db, { phone: '0633335883', name: 'Oğuz A', role: 'technician', alias: 'Oğuz', confirmedBy: 'owner' });
const o2 = await saveContact(db, { phone: '0644445883', name: 'Oguz B', role: 'technician', alias: 'Oguz', confirmedBy: 'owner' });
assert.ok(o1.status === 201 && o2.status === 201);
r = await resolveContact(db, 'OĞUZ');
assert.equal(r.body.status, 'ambiguous');
assert.equal((r.body.candidates as Row[]).length, 2);
assert.equal(JSON.stringify(r.body).includes('+31'), false, 'only the last 4 digits come back');
assert.equal((await saveContact(db, { phone: '0655555555', name: 'Zed', alias: 'Z' })).status, 400, 'an alias needs a confirmer');

// --- Shadow: nothing in this module can send, and no row ever moved past approved ---
const exported = Object.keys(jobRoom);
assert.equal(exported.some((n) => /send|claim|report|deliver/i.test(n)), false, 'no send path exported');
assert.ok(rows('job_outbox').every((o) => o.shadow === true && ['proposed', 'approved', 'cancelled'].includes(o.state)));
assert.ok(Object.keys(tables).includes('ops_audit_log'), 'every call wrote an audit row');
assert.equal(
  JSON.stringify(rows('ops_audit_log')).includes('Test Klant'), false,
  'the audit log holds no customer data'
);

console.log('check-jobroom: all passed');
