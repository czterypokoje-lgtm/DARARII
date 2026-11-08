/**
 * SQL checks for migrations 0078 to 0082 on a throwaway, in-memory Postgres.
 *
 *   PGLITE_DIR=/path/to/folder/with/node_modules node scripts/check-jobroom-sql.mts
 *
 * PGLITE_DIR holds an install of @electric-sql/pglite (kept out of the repo's
 * dependencies on purpose). Nothing here touches a network service or the real
 * Supabase project. The CRM tables the migrations point at (technicians, leads,
 * jobs) and crm_role() are stubbed; RLS roles are real Postgres roles.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const dir = process.env.PGLITE_DIR;
if (!dir) {
  console.log('check-jobroom-sql: skipped (set PGLITE_DIR to a folder with @electric-sql/pglite installed)');
  process.exit(0);
}
const require = createRequire(`${dir}/package.json`);
const { PGlite } = require('@electric-sql/pglite') as { PGlite: new () => any };
const pg = new PGlite();

const h64 = (c: string) => c.repeat(64);
const q = (sql: string, params: unknown[] = []) => pg.query(sql, params);
const rowsOf = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows as Record<string, any>[];
async function fails(why: string, sql: string, params: unknown[] = [], match?: RegExp) {
  try {
    await q(sql, params);
  } catch (e) {
    if (match) assert.match((e as Error).message, match, `${why}: wrong error`);
    return;
  }
  assert.fail(`${why}: expected an error`);
}

let checks = 0;
const ok = (cond: unknown, msg: string) => { checks++; assert.ok(cond, msg); };

// --- stubs the migrations expect from the existing CRM ---
await pg.exec(`
  create role authenticated nologin; create role anon nologin; create role service_role nologin;
  create table public.technicians (id uuid primary key default gen_random_uuid());
  create table public.leads (id uuid primary key default gen_random_uuid());
  create table public.jobs (id uuid primary key default gen_random_uuid());
  create function public.crm_role() returns text language sql stable as $$ select nullif(current_setting('app.role', true), '') $$;
  grant usage on schema public to authenticated, anon, service_role;
`);

// --- 1. all five migrations apply, in order, and apply again ---
const files = [
  '0078_job_room.sql', '0079_job_outbox_attachment.sql', '0080_job_approvers.sql', '0081_job_heartbeats.sql', '0082_job_room_hardening.sql',
];
for (const f of files) await pg.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
for (const f of files) await pg.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
ok(true, 'migrations 0078-0082 apply, and apply again (idempotent)');

// --- fixtures ---
const contact = async (phone: string, role: string, name = 'Test') =>
  (await rowsOf(`insert into contacts (phone_e164, display_name, role) values ($1,$2,$3) returning id`, [phone, name, role]))[0].id as string;
const customer = await contact('+31600000011', 'customer');
const owner = await contact('+31600000099', 'owner');
const staff = await contact('+31600000098', 'staff');
const room = (await rowsOf(`insert into job_rooms (customer_contact_id) values ($1) returning id, code`, [customer]))[0];
ok(Number(room.code) === 1, 'job code starts at 1 (J-1)');

const outbox = async (over: Record<string, unknown> = {}) => {
  const r = { job_room_id: room.id, contact_id: customer, audience: 'customer_reply', kind: 'note', tier: 1, body: 'Hallo', text_hash: h64('a'), dedupe_key: randomUUID().replace(/-/g, '').padEnd(64, '0'), shadow: true, ...over };
  const cols = Object.keys(r);
  return (await rowsOf(`insert into job_outbox (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(r)))[0].id as string;
};

// --- 2. constraints ---
await fails('bad phone', `insert into contacts (phone_e164, display_name) values ('0612345678','x')`, [], /check/i);
await fails('duplicate phone', `insert into contacts (phone_e164, display_name) values ('+31600000011','x')`, [], /unique|duplicate/i);
await fails('bad postcode4', `insert into job_rooms (postcode4) values ('35AB')`, [], /check/i);
await fails('bad hash', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key) values ($1,$2,'customer_reply','k',1,'b','nothex',$3)`, [room.id, customer, h64('b')], /check/i);
await fails('bad tier', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key) values ($1,$2,'customer_reply','k',3,'b',$3,$4)`, [room.id, customer, h64('c'), h64('d')], /check/i);
await fails('bad audience', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key) values ($1,$2,'everyone','k',1,'b',$3,$4)`, [room.id, customer, h64('c'), h64('e')], /check/i);
checks += 6;

// --- 3. shadow lock: insert side and update side ---
await fails('shadow row cannot be created as sent', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key,state,shadow) values ($1,$2,'customer_reply','k',1,'b',$3,$4,'sent',true)`, [room.id, customer, h64('c'), h64('f')]);
await fails('row cannot be inserted with shadow = false', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key,shadow) values ($1,$2,'customer_reply','k',1,'b',$3,$4,false)`, [room.id, customer, h64('c'), h64('0')], /shadow/i);
const o1 = await outbox({ body: 'Eerste', text_hash: h64('1') });
await fails('shadow cannot be flipped off', `update job_outbox set shadow = false where id = $1`, [o1], /progress columns|shadow/i);
await fails('shadow row cannot be marked sent', `update job_outbox set state = 'sent' where id = $1`, [o1], /check|shadow/i);
await fails('shadow row cannot be claimed', `update job_outbox set state = 'claimed' where id = $1`, [o1]);
await fails('shadow row cannot be unknown', `update job_outbox set state = 'unknown' where id = $1`, [o1]);
checks += 6;

// --- 4. immutable outbox ---
const otherRoom = (await rowsOf(`insert into job_rooms default values returning id`))[0].id;
for (const [col, val] of [['body', 'Anders'], ['contact_id', staff], ['audience', 'technician'], ['tier', 0], ['kind', 'other'], ['text_hash', h64('9')], ['dedupe_key', h64('8')], ['job_room_id', otherRoom], ['attachment', '{"type":"x"}']] as const) {
  await fails(`${col} cannot change after insert`, `update job_outbox set ${col} = $1 where id = $2`, [val, o1], /progress columns/i);
}
await q(`update job_outbox set approved_by = 'x', approved_at = now(), attempts = 1, last_error = 'e' where id = $1`, [o1]);
await q(`update job_outbox set state = 'failed' where id = $1`, [o1]);
ok((await rowsOf(`select state, attempts from job_outbox where id = $1`, [o1]))[0].state === 'failed', 'progress columns can change');
await fails('outbox rows are never deleted', `delete from job_outbox where id = $1`, [o1], /never deleted/i);
checks += 9;

// --- 5. append-only log ---
const ev = (await rowsOf(`insert into job_events (job_room_id,direction,channel,actor,kind,body) values ($1,'in','whatsapp','transport','message','Hallo') returning id`, [room.id]))[0].id;
await fails('event update', `update job_events set body = 'x' where id = $1`, [ev], /append-only/i);
await fails('event delete', `delete from job_events where id = $1`, [ev], /append-only/i);
await fails('job room with events cannot be deleted (its events would change)', `delete from job_rooms where id = $1`, [room.id], /append-only/i);
await fails('bad event direction', `insert into job_events (direction,channel,actor,kind) values ('sideways','whatsapp','a','k')`, [], /check/i);
await q(`insert into job_events (channel,provider_message_id,direction,actor,kind) values ('whatsapp','wamid.A','in','transport','message')`);
await fails('same provider message id twice', `insert into job_events (channel,provider_message_id,direction,actor,kind) values ('whatsapp','wamid.A','in','transport','message')`, [], /unique|duplicate/i);
checks += 5;

// --- 6. approvals: the function is atomic, and the table is append-only ---
const decide = (id: string, decision: string, hash: string) =>
  rowsOf(`select * from job_decide_approval($1,$2,$3,'Owner Test','owner_tap')`, [id, decision, hash]);
const o2 = await outbox({ body: 'Tweede', text_hash: h64('2') });
await fails('wrong hash', `select * from job_decide_approval($1,'approved',$2,'x','owner_tap')`, [o2, h64('3')], /hash_changed/);
await fails('unknown row', `select * from job_decide_approval($1,'approved',$2,'x','owner_tap')`, [randomUUID(), h64('2')], /not_found/);
await fails('a decision the table refuses rolls everything back', `select * from job_decide_approval($1,'maybe',$2,'x','owner_tap')`, [o2, h64('2')], /check/i);
ok((await rowsOf(`select state from job_outbox where id = $1`, [o2]))[0].state === 'proposed', 'failed approval leaves the row proposed');
ok((await rowsOf(`select count(*)::int as n from job_approvals where outbox_id = $1`, [o2]))[0].n === 0, 'and no approval behind');
const r1 = await decide(o2, 'approved', h64('2'));
ok(r1[0].new_state === 'approved' && Number(r1[0].code) >= 1, 'approve: state and code');
const st = (await rowsOf(`select state, approved_by, approved_at from job_outbox where id = $1`, [o2]))[0];
ok(st.state === 'approved' && st.approved_by === 'Owner Test' && st.approved_at, 'approve sets who and when');
await fails('second decision', `select * from job_decide_approval($1,'approved',$2,'x','owner_tap')`, [o2, h64('2')], /already_decided/);
const o4 = await outbox({ body: 'Derde', text_hash: h64('4') });
await decide(o4, 'rejected', h64('4'));
ok((await rowsOf(`select state from job_outbox where id = $1`, [o4]))[0].state === 'cancelled', 'reject cancels');
await fails('decision after reject', `select * from job_decide_approval($1,'approved',$2,'x','owner_tap')`, [o4, h64('4')], /already_decided/);
ok((await rowsOf(`select count(*)::int as n from job_approvals`))[0].n === 2, 'exactly the two successful decisions are recorded');
await fails('approval row cannot be edited', `update job_approvals set decision = 'rejected'`, [], /append-only/i);
await fails('approval row cannot be deleted', `delete from job_approvals`, [], /append-only/i);
checks += 6;

// --- 7. approvers: role must match the contact ---
await fails('owner approver on a customer contact', `insert into job_approvers (contact_id, role) values ($1,'owner')`, [customer], /does not match/i);
await fails('assistant approver on a customer contact', `insert into job_approvers (contact_id, role) values ($1,'assistant')`, [customer], /does not match/i);
await fails('assistant approver on an owner contact', `insert into job_approvers (contact_id, role) values ($1,'assistant')`, [owner], /does not match/i);
await q(`insert into job_approvers (contact_id, role) values ($1,'owner')`, [owner]);
await q(`insert into job_approvers (contact_id, role, audiences, max_tier) values ($1,'assistant','{customer_reply}',2)`, [staff]);
await fails('an assistant row cannot be turned into an owner row', `update job_approvers set role = 'owner' where contact_id = $1`, [staff], /does not match/i);
await fails('bad audience list', `insert into job_approvers (contact_id, role, audiences) values ($1,'assistant','{everyone}')`, [await contact('+31600000097', 'staff')], /check/i);
const defaults = (await rowsOf(`select max_tier, may_invoice from job_approvers where role = 'owner'`))[0];
ok(defaults.max_tier === 0 && defaults.may_invoice === false, 'rights start restrictive (nothing granted, invoices off)');
checks += 4;

// --- 8. heartbeat claim is atomic and windowed ---
ok((await rowsOf(`select job_heartbeat_claim_alert('transport', 60) as c`))[0].c === true, 'first claim wins (and creates the row)');
ok((await rowsOf(`select job_heartbeat_claim_alert('transport', 60) as c`))[0].c === false, 'second claim inside the window loses');
await q(`update job_heartbeats set alerted_at = now() - interval '61 minutes' where service = 'transport'`);
ok((await rowsOf(`select job_heartbeat_claim_alert('transport', 60) as c`))[0].c === true, 'after the window it can claim again');
await q(`update job_heartbeats set beat_at = now(), alerted_at = null where service = 'transport'`);
ok((await rowsOf(`select job_heartbeat_claim_alert('transport', 60) as c`))[0].c === true, 'a beat clears the alert');
await fails('service name check', `insert into job_heartbeats (service) values ('Bad Name!')`, [], /check/i);
checks += 1;

// --- 9. attachment size: bytes, not characters ---
const bigChars = { type: 'invoice_pdf', pad: 'é'.repeat(990) };
const bytes = Buffer.byteLength(JSON.stringify(bigChars), 'utf8');
ok(JSON.stringify(bigChars).length < 2000 && bytes > 2000, 'fixture: characters < 2000 < bytes');
await fails('attachment over 2000 bytes', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key,attachment) values ($1,$2,'self_started','invoice:x',2,'b',$3,$4,$5)`, [room.id, customer, h64('c'), h64('7'), JSON.stringify(bigChars)], /check/i);
await q(`insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key,attachment) values ($1,$2,'self_started','invoice:x',2,'b',$3,$4,$5)`, [room.id, customer, h64('c'), h64('6'), JSON.stringify({ type: 'invoice_pdf', total: 149.5 })]);
checks += 2;

// --- 10. row level security: only the owner reads, nobody writes ---
const tables = ['contacts', 'contact_aliases', 'job_rooms', 'job_parties', 'job_events', 'job_outbox', 'job_approvals', 'job_approvers', 'job_heartbeats'];
for (const t of tables) {
  const r = (await rowsOf(`select relrowsecurity as rls from pg_class where oid = 'public.${t}'::regclass`))[0];
  ok(r.rls === true, `RLS on ${t}`);
  ok((await rowsOf(`select 1 from pg_policies where schemaname='public' and tablename=$1 and policyname=$2`, [t, `${t}_owner_read`])).length === 1, `owner-read policy on ${t}`);
}
const count = async (role: string, appRole: string | null, t: string) => {
  await q(`set role ${role}`);
  await q(`select set_config('app.role', $1, false)`, [appRole ?? '']);
  try { return (await rowsOf(`select count(*)::int as n from ${t}`))[0].n as number; } finally { await q('reset role'); }
};
for (const t of ['job_outbox', 'job_events', 'contacts', 'job_approvals']) {
  ok((await count('authenticated', 'owner', t)) > 0, `owner reads ${t}`);
  ok((await count('authenticated', 'kantoor', t)) === 0, `kantoor sees no rows of ${t}`);
  ok((await count('authenticated', null, t)) === 0, `no role sees no rows of ${t}`);
}
await q('set role anon');
await fails('anon cannot read', `select * from job_outbox`, [], /permission denied/i);
await q('reset role');
await q('set role authenticated');
await q(`select set_config('app.role', 'owner', false)`);
await fails('even the owner cannot write through RLS', `insert into contacts (phone_e164, display_name) values ('+31600000055','x')`, [], /permission denied/i);
await fails('nor update', `update job_outbox set state = 'cancelled'`, [], /permission denied/i);
await fails('nor call the approval function', `select * from job_decide_approval(gen_random_uuid(),'approved',$1,'x','owner_tap')`, [h64('1')], /permission denied/i);
await fails('nor claim an alert', `select job_heartbeat_claim_alert('transport', 1)`, [], /permission denied/i);
await q('reset role');
checks += 5;

// --- 11. what the code writes fits the tables (column names and types) ---
const o3 = await outbox({ audience: 'self_started', kind: 'invoice:I-00001:abc123abc123', tier: 2, body: 'Beste Klant', text_hash: h64('5'), dedupe_key: h64('5'), attachment: JSON.stringify({ type: 'invoice_pdf', invoiceNumber: 'I-00001', total: 149.5, snapshotHash: h64('9') }) });
ok(o3, 'the invoice row shape the code inserts is accepted');

console.log(`check-jobroom-sql: all passed (${checks} checks, 5 migrations applied twice on a throwaway Postgres)`);
