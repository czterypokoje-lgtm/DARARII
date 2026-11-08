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
import * as J from '../src/lib/opsJobRoom.ts';
import { pgClient } from './lib/pgliteClient.mts';

const dir = process.env.PGLITE_DIR;
if (!dir) {
  console.log('check-jobroom-sql: skipped (set PGLITE_DIR to a folder with @electric-sql/pglite installed)');
  process.exit(0);
}
const require = createRequire(`${dir}/package.json`);
const { PGlite } = require('@electric-sql/pglite') as { PGlite: new () => any };
const pg = new PGlite();

const h64 = (c: string) => c.repeat(64).slice(0, 64);
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
  -- Roles like Supabase's: none is a superuser; service_role bypasses RLS; and (this is the dangerous part)
  -- Supabase's default privileges hand every new table, sequence and function in public to all three.
  create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create table public.technicians (id uuid primary key default gen_random_uuid());
  create table public.leads (id uuid primary key default gen_random_uuid());
  create table public.jobs (id uuid primary key default gen_random_uuid());
  create function public.crm_role() returns text language sql stable as $$ select nullif(current_setting('app.role', true), '') $$;
  grant usage on schema public to authenticated, anon, service_role;
`);

// --- 1. all five migrations apply, in order, and apply again ---
const files = [
  '0078_job_room.sql', '0079_job_outbox_attachment.sql', '0080_job_approvers.sql', '0081_job_heartbeats.sql', '0082_job_room_hardening.sql', '0083_job_room_second_review.sql',
];
for (const f of files) await pg.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
for (const f of files) await pg.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
ok(true, 'migrations 0078-0083 apply, and apply again (idempotent)');

// --- fixtures (owner and staff contacts need the SQL-only switch of 0083) ---
await q(`select set_config('app.allow_staff_roles','on',false)`);
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
await fails('shadow row cannot be marked sent', `update job_outbox set state = 'sent' where id = $1`, [o1], /check|shadow|illegal transition/i);
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

// ===========================================================================
// 0083 and the handlers, as a non-superuser service_role with Supabase's default grants
// ===========================================================================
const as = async <T,>(role: string, fn: () => Promise<T>) => {
  await q(`set role ${role}`);
  try { return await fn(); } finally { await q('reset role'); }
};

// --- 12. contact roles: owner and staff only through SQL; roles never change ---
await q(`select set_config('app.allow_staff_roles','off',false)`);
await as('service_role', async () => {
  await fails('service role cannot create an owner contact', `insert into contacts (phone_e164, display_name, role) values ('+31600000201','x','owner')`, [], /SQL only/);
  await fails('nor a staff contact', `insert into contacts (phone_e164, display_name, role) values ('+31600000202','x','staff')`, [], /SQL only/);
  await q(`insert into contacts (phone_e164, display_name, role) values ('+31600000203','tech','technician')`);
  await fails('a role cannot change once set', `update contacts set role = 'customer' where phone_e164 = '+31600000203'`, [], /cannot change/);
  await fails('a customer cannot be promoted', `update contacts set role = 'staff' where id = $1`, [customer], /SQL only|cannot change/);
  await q(`update contacts set display_name = 'other name' where phone_e164 = '+31600000203'`);
});
await q(`select set_config('app.allow_staff_roles','on',false)`);
await q(`update contacts set role = 'garage' where phone_e164 = '+31600000203'`);
await q(`select set_config('app.allow_staff_roles','off',false)`);
checks += 7;

// --- 13. outbox state machine ---
const decideRow = async (hash: string) => outbox({ body: `sm-${hash.slice(0, 4)}`, text_hash: hash, dedupe_key: hash });
const approvalRow = (outboxId: string, decision: string, hash: string) =>
  q(`insert into job_approvals (outbox_id, job_room_id, decision, text_hash, decided_by, decided_via) values ($1,$2,$3,$4,'x','owner_tap')`, [outboxId, room.id, decision, hash]);
await as('service_role', async () => {
  const sA = await decideRow(h64('a1'));
  await fails('approved without an approval row', `update job_outbox set state = 'approved' where id = $1`, [sA], /matching approved/);
  const sB = await decideRow(h64('b1'));
  await approvalRow(sB, 'rejected', h64('b1'));
  await fails('approved with only a rejection on file', `update job_outbox set state = 'approved' where id = $1`, [sB], /matching approved/);
  const sC = await decideRow(h64('c1'));
  await approvalRow(sC, 'approved', h64('c2'));
  await fails('approved with an approval of another hash', `update job_outbox set state = 'approved' where id = $1`, [sC], /matching approved/);
  const sD = await decideRow(h64('d1'));
  await approvalRow(sD, 'approved', h64('d1'));
  await q(`update job_outbox set state = 'approved' where id = $1`, [sD]);
  ok(true, 'approved with a matching approved row works');
  await fails('approved cannot go back to proposed', `update job_outbox set state = 'proposed' where id = $1`, [sD], /illegal transition/);
  await fails('shadow rows cannot be claimed even from approved', `update job_outbox set state = 'claimed' where id = $1`, [sD]);
  await fails('approved cannot jump to sent', `update job_outbox set state = 'sent' where id = $1`, [sD]);
  await q(`update job_outbox set state = 'cancelled' where id = $1`, [sD]);
  for (const next of ['proposed', 'approved', 'claimed', 'sent', 'failed']) {
    await fails(`cancelled cannot become ${next}`, `update job_outbox set state = '${next}' where id = $1`, [sD], /illegal transition|check/);
  }
  await q(`update job_outbox set state = 'failed' where id = $1`, [sA]);
  await fails('failed is final', `update job_outbox set state = 'proposed' where id = $1`, [sA], /illegal transition/);
  await fails('a row cannot be inserted as approved', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key,state) values ($1,$2,'customer_reply','k',1,'b',$3,$4,'approved')`, [room.id, customer, h64('e0'), h64('e1')], /inserted as proposed/);
  await fails('proposed cannot jump to sent', `update job_outbox set state = 'sent' where id = $1`, [await decideRow(h64('f1'))]);
});
checks += 7;

// --- 14. TRUNCATE and privileges, with the dangerous default grants in place ---
const ALL9 = ['contacts', 'contact_aliases', 'job_rooms', 'job_parties', 'job_events', 'job_outbox', 'job_approvals', 'job_approvers', 'job_heartbeats'];
for (const role of ['anon', 'authenticated']) {
  await as(role, async () => {
    for (const t of ALL9) {
      const col = t === 'job_heartbeats' ? 'beat_at' : 'created_at';
      await fails(`${role} insert ${t}`, `insert into public.${t} default values`, [], /permission denied/i);
      await fails(`${role} update ${t}`, `update public.${t} set ${col} = ${col} where false`, [], /permission denied/i);
      await fails(`${role} remove rows from ${t}`, `delete from public.${t} where false`, [], /permission denied/i);
      await fails(`${role} empty ${t}`, `truncate public.${t}`, [], /permission denied/i);
    }
  });
}
for (const t of ['job_events', 'job_approvals', 'job_outbox']) {
  await fails(`emptying ${t} is refused even for the owner of the table`, `truncate public.${t}`, [], /cannot be truncated|foreign key/);
  await as('service_role', () => fails(`emptying ${t} by service_role`, `truncate public.${t}`, [], /cannot be truncated|foreign key/));
}
await as('service_role', async () => {
  await fails('service role cannot edit an event', `update job_events set kind = 'x' where id = $1`, [ev], /append-only/);
  await fails('service role cannot remove an event', `delete from job_events where id = $1`, [ev], /append-only/);
  await fails('service role cannot remove an approval', `delete from job_approvals`, [], /append-only/);
  await fails('service role cannot remove an outbox row', `delete from job_outbox where id = $1`, [o2], /never deleted/);
  await fails('service role cannot flip shadow', `update job_outbox set shadow = false where id = $1`, [o2], /progress columns/);
  await fails('service role cannot change the text of a row', `update job_outbox set body = 'x' where id = $1`, [o2], /progress columns/);
  await fails('service role cannot insert a non-shadow row', `insert into job_outbox (job_room_id,contact_id,audience,kind,tier,body,text_hash,dedupe_key,shadow) values ($1,$2,'customer_reply','k',1,'b',$3,$4,false)`, [room.id, customer, h64('a0'), h64('a9')], /shadow/);
  await q(`insert into contacts (phone_e164, display_name) values ('+31600000204','works as service role')`);
});
checks += 9;

// --- 15. search_path pinned; functions callable only by the service role ---
const fns = await rowsOf(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'job\\_%'`);
ok(fns.length >= 9, `found the job functions (${fns.length})`);
for (const f of fns) ok((f.proconfig ?? []).some((c: string) => /^search_path=public, pg_temp$/.test(c)), `search_path pinned on ${f.proname}`);
for (const sig of ['job_decide_approval(uuid,text,text,text,text)', 'job_heartbeat_claim_alert(text,integer)', 'job_redact_contact_messages(uuid,text)']) {
  for (const role of ['anon', 'authenticated']) {
    ok((await rowsOf(`select has_function_privilege('${role}', 'public.${sig}', 'execute') as x`))[0].x === false, `${role} cannot execute ${sig}`);
  }
  ok((await rowsOf(`select has_function_privilege('service_role', 'public.${sig}', 'execute') as x`))[0].x === true, `service_role can execute ${sig}`);
}

// --- 16. redaction: bodies blanked, hashes and ids kept, its own event ---
const victim = await contact('+31600000301', 'customer', 'Wis Mij');
const vRoom = (await rowsOf(`insert into job_rooms (customer_contact_id) values ($1) returning id`, [victim]))[0].id;
const vEv = (await rowsOf(`insert into job_events (job_room_id, contact_id, direction, channel, actor, kind, body, meta) values ($1,$2,'in','whatsapp','transport','message','Mijn nummer is 0612345678','{"x":1}') returning id`, [vRoom, victim]))[0].id;
await q(`insert into job_events (job_room_id, contact_id, direction, channel, actor, kind, body) values ($1,$2,'out','whatsapp','transport','send.result','Uw offerte')`, [vRoom, victim]);
const bystander = (await rowsOf(`insert into job_events (job_room_id, contact_id, direction, channel, actor, kind, body) values ($1,$2,'in','whatsapp','transport','message','Ander mens') returning id`, [room.id, customer]))[0].id;
const vOut = async (body: string, hash: string, final: string | null) => {
  const id = await outbox({ job_room_id: vRoom, contact_id: victim, body, text_hash: hash, dedupe_key: hash });
  if (final) await q(`update job_outbox set state = $2 where id = $1`, [id, final]);
  return id;
};
const vCancelled = await vOut('Offerte voor Wis Mij', h64('71'), 'cancelled');
const vFailed = await vOut('Tweede bericht', h64('72'), 'failed');
const vWaiting = await vOut('Nog niet verstuurd', h64('73'), null);
await fails('a body cannot be blanked by hand', `update job_events set body = '[verwijderd]' where id = $1`, [vEv], /append-only/);
await fails('a reason code is required', `select * from job_redact_contact_messages($1, '')`, [victim], /reason/);
await as('authenticated', () => fails('authenticated cannot redact', `select * from job_redact_contact_messages($1, 'avg-verzoek')`, [victim], /permission denied/i));
await as('anon', () => fails('anon cannot redact', `select * from job_redact_contact_messages($1, 'avg-verzoek')`, [victim], /permission denied/i));
const red = await as('service_role', () => rowsOf(`select * from job_redact_contact_messages($1, 'avg-verzoek 2026-11')`, [victim]));
ok(Number(red[0].events_redacted) === 2 && Number(red[0].outbox_redacted) === 2, 'two events and two finished outbox rows redacted');
const evAfter = (await rowsOf(`select body, meta, redacted_at, kind, direction, channel, contact_id, created_at from job_events where id = $1`, [vEv]))[0];
ok(evAfter.body === '[verwijderd]' && Object.keys(evAfter.meta).length === 0 && evAfter.redacted_at, 'event body and meta blanked, time stamped');
ok(evAfter.kind === 'message' && evAfter.direction === 'in' && evAfter.contact_id === victim, 'kind, direction, contact and time are kept');
const outAfter = await rowsOf(`select id, body, text_hash, state, redacted_at from job_outbox where id = any($1)`, [[vCancelled, vFailed, vWaiting]]);
ok(outAfter.find((o) => o.id === vCancelled)!.body === '[verwijderd]' && outAfter.find((o) => o.id === vCancelled)!.text_hash === h64('71'), 'finished outbox body blanked, hash kept');
ok(outAfter.find((o) => o.id === vWaiting)!.body === 'Nog niet verstuurd' && !outAfter.find((o) => o.id === vWaiting)!.redacted_at, 'a waiting message is left alone (cancel it first)');
ok((await rowsOf(`select body from job_events where id = $1`, [bystander]))[0].body === 'Ander mens', 'other contacts untouched');
const privacy = (await rowsOf(`select kind, actor, meta, body from job_events where kind = 'privacy.redacted'`))[0];
ok(privacy.actor === 'jobroom-privacy' && privacy.meta.events === 2 && privacy.meta.outbox === 2 && privacy.body === null, 'its own event: counts only, no text');
ok(!JSON.stringify(privacy).includes('0612'), 'the event holds no message content');
const again = await as('service_role', () => rowsOf(`select * from job_redact_contact_messages($1, 'avg-verzoek 2026-11')`, [victim]));
ok(Number(again[0].events_redacted) === 0, 'a second run redacts nothing more');
await fails('redacted rows are still immutable', `update job_events set body = 'terug' where id = $1`, [vEv], /append-only/);
await fails('and the outbox text still cannot be edited', `update job_outbox set body = 'terug' where id = $1`, [vCancelled], /progress columns/);

// --- 17. the real handlers on this Postgres, as service_role ---
process.env.JOBROOM_APPROVAL_SECRET = 'a'.repeat(40);
const SECRET = process.env.JOBROOM_APPROVAL_SECRET;
const nowSec = () => Math.floor(Date.now() / 1000);
await q(`select set_config('app.allow_staff_roles','on',false)`);
const ownerC = await contact('+31600000091', 'owner', 'Eigenaar');
const asstC = await contact('+31600000092', 'staff', 'Assistent');
await q(`select set_config('app.allow_staff_roles','off',false)`);
await q(`insert into job_approvers (contact_id, role) values ($1,'owner')`, [ownerC]);
await q(`insert into job_approvers (contact_id, role, audiences, max_tier) values ($1,'assistant','{customer_reply}',2)`, [asstC]);
const db = pgClient(pg);
await as('service_role', async () => {
  ok((await J.saveContact(db, { phone: '0600000093', name: 'Nep', role: 'owner' })).status === 403, 'API refuses owner');
  const cust = (await J.saveContact(db, { phone: '0600000094', name: 'Echte Klant', role: 'customer' })).body.contactId as string;
  const tech = (await J.saveContact(db, { phone: '0600000095', name: 'Echte Monteur', role: 'technician' })).body.contactId as string;
  const leadId = (await rowsOf(`insert into leads default values returning id`))[0].id; // the lead is a real row in the CRM
  const opened = await J.openJobRoom(db, { leadId, customer: { phone: '0600000094', name: 'Echte Klant' } });
  ok(opened.status === 201, `room opened: ${JSON.stringify(opened)}`);
  const roomId = opened.body.jobRoomId as string;
  const ap = await J.addParty(db, { jobRoomId: roomId, contactId: tech, role: 'technician' });
  ok(ap.status === 201, `technician added: ${JSON.stringify(ap)}`);
  ok((await J.addParty(db, { jobRoomId: roomId, contactId: asstC, role: 'assistant' })).status === 201, 'approver added as assistant');

  const aud = async (id: unknown) => (await rowsOf(`select audience, tier from job_outbox where id = $1`, [id]))[0];
  // tier and audience are part of the key, and the audience is derived
  const t1 = await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 1, body: 'Zelfde tekst voor de test', audience: 'customer_reply' });
  const t2 = await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 2, body: 'Zelfde tekst voor de test' });
  ok(t1.status === 201 && t2.status === 201 && t1.body.outboxId !== t2.body.outboxId, 'same text, other tier: another row');
  ok((await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 2, body: 'Zelfde tekst voor de test' })).body.duplicate === true, 'same tier: the same row');
  ok((await aud(t1.body.outboxId)).audience === 'self_started', 'the audience hint is ignored: the customer has not written first');
  await J.recordEvent(db, { direction: 'in', channel: 'whatsapp', actor: 'transport', kind: 'message', jobRoomId: roomId, contactId: cust, providerMessageId: 'wamid.PG1', body: 'Hallo' });
  const t3 = await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 1, body: 'Antwoord na hun bericht' });
  ok((await aud(t3.body.outboxId)).audience === 'customer_reply', 'after the customer wrote, the reply is customer_reply');
  const tt = await J.proposeOutbox(db, { jobRoomId: roomId, contactId: tech, kind: 'note', tier: 1, body: 'Naar de monteur' });
  ok((await aud(tt.body.outboxId)).audience === 'technician', 'technician audience');
  ok((await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'ack', tier: 0, body: 'Pay now at http://evil.tk, IBAN NL91ABNA0417164300' })).status === 422, 'tier 0 refuses caller text');
  ok((await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'ack', tier: 0 })).status === 201, 'tier 0 sends the template');
  ok((await J.proposeOutbox(db, { jobRoomId: roomId, contactId: asstC, kind: 'note', tier: 1, body: 'Klant belt 0612345678' })).status === 201, 'internal text for a real approver');
  ok((await J.proposeOutbox(db, { jobRoomId: roomId, contactId: ownerC, kind: 'note', tier: 1, body: 'x' })).status === 403, 'owner who is not on this job: refused');

  const mk = (id: string, hash: string, phone: string, via: string, d = 'approved') =>
    J.decideApproval(db, { token: J.signApproval({ o: id, h: hash, p: phone, v: via as never, d: d as never, i: nowSec(), e: nowSec() + 300 }, SECRET) });
  const asstOnSelf = await mk(t1.body.outboxId as string, t1.body.textHash as string, '+31600000092', 'assistant');
  ok(asstOnSelf.body.reason === 'not_allowed_audience', 'assistant cannot release a self_started message');
  const asstOnReply = await mk(t3.body.outboxId as string, t3.body.textHash as string, '+31600000092', 'assistant');
  ok(asstOnReply.status === 201, 'assistant releases a customer_reply message');
  const row = (await rowsOf(`select approved_by, state from job_outbox where id = $1`, [t3.body.outboxId]))[0];
  ok(/^[0-9a-f-]{36}$/.test(row.approved_by) && row.state === 'approved', 'approved_by is the contact id');
  ok((await rowsOf(`select decided_by from job_approvals where outbox_id = $1`, [t3.body.outboxId]))[0].decided_by === asstC, 'decided_by is the contact id');
  ok((await mk(t3.body.outboxId as string, t3.body.textHash as string, '+31600000091', 'owner_tap')).status === 409, 'second decision refused by the real function');
  const own = await mk(t2.body.outboxId as string, t2.body.textHash as string, '+31600000091', 'owner_tap');
  ok(own.status === 201, 'owner releases tier 2');

  const same = await Promise.all(Array.from({ length: 50 }, () => J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 1, body: 'Parallel dezelfde tekst' })));
  ok(same.filter((r) => r.status === 201).length === 1 && same.filter((r) => r.body.duplicate === true).length === 49, '50 parallel proposes, one key: one row');
  const diff = await Promise.all(Array.from({ length: 50 }, (_, i) => J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 1, body: `Parallel unieke tekst ${i}` })));
  ok(diff.every((r) => r.status === 201), '50 different keys: 50 rows');
  const pr = await J.proposeOutbox(db, { jobRoomId: roomId, contactId: cust, kind: 'note', tier: 1, body: 'Dubbele goedkeuring parallel' });
  const tok = J.signApproval({ o: pr.body.outboxId as string, h: pr.body.textHash as string, p: '+31600000091', v: 'owner_tap', d: 'approved', i: nowSec(), e: nowSec() + 300 }, SECRET);
  const dbl = await Promise.all(Array.from({ length: 20 }, () => J.decideApproval(db, { token: tok })));
  ok(dbl.filter((r) => r.status === 201).length === 1, '20 parallel approvals: one wins');
  ok((await rowsOf(`select count(*)::int as n from job_approvals where outbox_id = $1`, [pr.body.outboxId]))[0].n === 1, 'and one approval row');

  const ib = await Promise.all(Array.from({ length: 20 }, () => J.recordInbound(db, { phone: '0600000096', providerMessageId: 'wamid.PGRACE', body: 'Hallo', waName: 'Race' })));
  ok(ib.every((r) => r.status === 200 || r.status === 201), '20 parallel inbound: no errors');
  ok((await rowsOf(`select count(*)::int as n from job_events where provider_message_id = 'wamid.PGRACE'`))[0].n === 1, 'one event');
  ok((await J.recordEvent(db, { direction: 'in', channel: 'whatsapp', actor: 'transport', kind: 'approval.refused' })).status === 400, 'reserved kind refused');
  ok((await J.recordHeartbeat(db, { service: 'evil' })).status === 400, 'unknown service refused');
  const beats = await Promise.all(Array.from({ length: 20 }, () => J.recordHeartbeat(db, { service: 'transport' })));
  ok(beats.every((r) => r.status === 200), '20 parallel heartbeats (upsert): no errors');
  ok((await rowsOf(`select count(*)::int as n from job_heartbeats where service = 'transport'`))[0].n === 1, 'one row');
  await q(`update job_heartbeats set beat_at = '2026-11-08T07:00:00Z', alerted_at = null where service = 'transport'`);
  const at = new Date('2026-11-08T08:00:00Z');
  const sent: string[] = [];
  await Promise.all(Array.from({ length: 20 }, () => J.checkHeartbeats(db, { expected: ['transport'], alert: true, alertsOn: true, notify: async (t) => void sent.push(t), now: at })));
  ok(sent.length === 1, '20 overlapping alarm checks: one alert');
});

console.log(`check-jobroom-sql: all passed (${checks} checks, 6 migrations applied twice on a throwaway Postgres)`);
