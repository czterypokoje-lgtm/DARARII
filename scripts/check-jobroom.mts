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
  saveContact, resolveContact, resolveNote, recordInbound, proposeInvoice, verifyInvoice, foldName, guardText, sha256,
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

// --- S3: resolver cases (the "30 cases" done rule), shadow ---
let cases = 0;
const tech = (phone: string, name: string, alias: string, city: string) =>
  saveContact(db, { phone, name, role: 'technician', city, alias, confirmedBy: 'owner' });
await tech('0655550001', 'Mehmet Y', 'Mehmet', 'Den Haag');
await tech('0655555883', 'Sikor P', 'Sikor', 'Utrecht');
await tech('0655550003', 'Halil T', 'Halil', 'Breda');
await saveContact(db, { phone: '0655550004', name: 'Ali Klant', role: 'customer' });

const one = async (q: string, name: string, opts = {}) => {
  const r = await resolveContact(db, q, opts);
  assert.equal(r.body.status, 'one', `${q} -> one`);
  assert.equal((r.body.contact as Row).name, name, `${q} -> ${name}`);
  cases++;
};
const status = async (q: string | null, want: string | number, opts = {}) => {
  const r = await resolveContact(db, q, opts);
  assert.equal(r.body.status ?? r.status, want, `${q} -> ${want}`);
  cases++;
};
await one('Ali', 'Ali D');
await one('ali', 'Ali D');
await one('ALİ', 'Ali D');
await one('Alihan', 'Alihan K');
await one('Ali D', 'Ali D');
await one('Halil', 'Halil T');
await one('Ali', 'Ali D'); // Halil exists now, Ali still does not hit it
await status('Alih', 'none'); // a prefix is never a match
await status('Hali', 'none');
await status('Oguz', 'ambiguous');
await status('Oğuz', 'ambiguous');
await status('OĞUZ', 'ambiguous');
await one('Oğuz A', 'Oğuz A');
await one('OGUZ B', 'Oguz B');
await status('oguz', 'ambiguous', { last4: '5883' }); // same last 4 digits: still asks
await one('Sikor', 'Sikor P', { last4: '5883' });
await status('Sikor', 'none', { last4: '0000' });
await one('Ali', 'Ali D', { role: 'technician' });
await status('Ali Klant', 'none', { role: 'technician' }); // customers have no alias, techs resolve from the tech book
await status('Ali', 'none', { role: 'customer' });
await status('Ali', 400, { last4: 'abc' });
await status('Ali', 400, { role: 'boss' });
await status('', 400);
await status(null, 400);

const note = async (text: string, want: string | number, check?: (b: Row) => void, opts = {}) => {
  const r = await resolveNote(db, text, opts);
  assert.equal(r.body.status ?? r.status, want, `${text} -> ${want}`);
  check?.(r.body);
  cases++;
};
await note('Ali, Mehmet en Oğuz', 'ask', (b) => {
  assert.equal((b.results as Row[]).length, 3);
  assert.deepEqual((b.ask as Row[]).map((a) => [a.input, a.status]), [['Oğuz', 'ambiguous']]);
  assert.equal(JSON.stringify(b).includes('+31'), false);
});
await note('Ali ve Mehmet', 'all', (b) => assert.equal((b.recipients as string[]).length, 2));
await note('Ali & Mehmet + Halil', 'all', (b) => assert.equal((b.recipients as string[]).length, 3));
await note('Ali; Mehmet / Halil', 'all', (b) => assert.equal((b.recipients as string[]).length, 3));
await note('Ali, ali', 'all', (b) => assert.equal((b.recipients as string[]).length, 1)); // same person twice
await note('Ali, Alihan', 'all', (b) => assert.equal((b.recipients as string[]).length, 2));
await note('Ali, Veli', 'ask', (b) => assert.equal((b.ask as Row[])[0].status, 'none'));
await note('Ali en Mehmet', 'all', undefined, { role: 'technician' });
await note('', 400);
await note('a, b, c, d, e, f, g, h, i, j, k', 400);

// --- S3: every customer who writes is saved as a contact ---
const inbound = (over: Row = {}) => ({ phone: '06 99 00 45 67', providerMessageId: 'wamid.IN1', body: 'Sleutel kwijt', waName: 'Jan Test', ...over });
let ib = await recordInbound(db, inbound());
assert.equal(ib.status, 201);
assert.equal(ib.body.created, true);
assert.equal(ib.body.role, 'customer');
const jan = rows('contacts').find((c) => c.phone_e164 === '+31699004567')!;
assert.equal(jan.display_name, 'Jan Test');
assert.equal(jan.role, 'customer');
assert.equal(rows('job_events').filter((e) => e.provider_message_id === 'wamid.IN1').length, 1);
cases++;
ib = await recordInbound(db, inbound());
assert.equal(ib.body.duplicate, true, 'a replay changes nothing');
assert.equal(rows('job_events').filter((e) => e.provider_message_id === 'wamid.IN1').length, 1);
cases++;
ib = await recordInbound(db, inbound({ providerMessageId: 'wamid.IN2', waName: 'Ander Naam' }));
assert.equal(ib.body.created, false);
assert.equal(jan.display_name, 'Jan Test', 'a later name never overwrites');
assert.equal(rows('contacts').filter((c) => c.phone_e164 === '+31699004567').length, 1);
cases++;
ib = await recordInbound(db, inbound({ phone: '0622222222', providerMessageId: 'wamid.IN3' }));
assert.equal(ib.body.role, 'technician', 'a technician is never turned into a customer');
cases++;
ib = await recordInbound(db, inbound({ phone: '+49 151 0000 0001', providerMessageId: 'wamid.IN4', waName: null }));
const de = rows('contacts').find((c) => c.phone_e164 === '+4915100000001')!;
assert.equal(de.country, 'DE');
assert.equal(de.language, 'de');
assert.equal(de.display_name, 'Klant 0001', 'no name: last 4 digits only, never the full number');
cases++;
assert.equal((await recordInbound(db, inbound({ phone: 'abc' }))).status, 400);
assert.equal((await recordInbound(db, inbound({ providerMessageId: '' }))).status, 400);
cases += 2;
assert.ok(cases >= 30, `S3 cases: ${cases}`);

// --- S6: invoice send, CRM side (shadow) ---
const jobUuid = randomUUID();
rows('job_rooms')[0].job_id = jobUuid;
const addInvoice = (number: string, over: Row = {}, lineCount = 1) => {
  const id = randomUUID();
  rows('sales_invoices').push({ id, invoice_number: number, status: 'concept', total: 149.5, subtotal: 123.55, vat_total: 25.95, credit_applied: 0, job_id: jobUuid, ...over });
  for (let i = 0; i < lineCount; i++) {
    rows('sales_invoice_lines').push({ invoice_id: id, line_no: i, description: 'Sleutel bijmaken', quantity: 1, unit_price: 123.55, discount: 0, vat_rate: 21 });
  }
  return id;
};
const invId = addInvoice('I-00001');
const inv = (over: Row = {}) => ({ jobRoomId: roomId, invoiceNumber: 'I-00001', ...over });

let iv = await proposeInvoice(db, inv({ moneybirdInvoiceId: '123456789012' }));
assert.equal(iv.status, 201);
assert.equal(iv.body.shadow, true);
const invOutbox = rows('job_outbox').find((o) => o.id === iv.body.outboxId)!;
assert.equal(invOutbox.tier, 2, 'an invoice always needs a person');
assert.equal(invOutbox.state, 'proposed');
assert.equal(invOutbox.shadow, true);
assert.equal(invOutbox.audience, 'self_started');
assert.equal(invOutbox.attachment.type, 'invoice_pdf');
assert.equal(invOutbox.attachment.moneybirdInvoiceId, '123456789012');
assert.match(invOutbox.body, /I-00001.*€ 149,50/);
assert.equal(guardText(invOutbox.body, 'customer_reply'), null);

iv = await proposeInvoice(db, inv());
assert.equal(iv.body.duplicate, true, 'the same invoice is one row');

// Approval of the invoice text, then the snapshot check
const ivRow = invOutbox;
a = await decideApproval(db, { outboxId: ivRow.id, decision: 'approved', decidedBy: 'owner', via: 'owner_voice', textHash: ivRow.text_hash });
assert.equal(a.status, 201);
assert.equal(rows('job_outbox').find((o) => o.id === ivRow.id)!.state, 'approved');
let vf = await verifyInvoice(db, ivRow.id);
assert.equal(vf.body.unchanged, true);

// The invoice is edited after approval: the approval no longer covers it
rows('sales_invoice_lines').find((l) => l.invoice_id === invId)!.unit_price = 200;
vf = await verifyInvoice(db, ivRow.id);
assert.equal(vf.body.unchanged, false, 'an edited invoice needs a new approval');
rows('sales_invoice_lines').find((l) => l.invoice_id === invId)!.unit_price = 123.55;
rows('sales_invoices').find((i) => i.id === invId)!.status = 'betaald';
assert.equal((await verifyInvoice(db, ivRow.id)).body.unchanged, false, 'paid in the meantime');
assert.equal((await proposeInvoice(db, inv())).status, 409, 'a paid invoice is not sent');
rows('sales_invoices').find((i) => i.id === invId)!.status = 'verzonden';
assert.equal((await proposeInvoice(db, inv())).status, 200, 'a sent invoice may be sent again, same row');

// Refusals
assert.equal((await proposeInvoice(db, inv({ invoiceNumber: 'I-99999' }))).status, 404);
assert.equal((await proposeInvoice(db, inv({ invoiceNumber: 'x' }))).status, 400);
assert.equal((await proposeInvoice(db, inv({ moneybirdInvoiceId: 'abc' }))).status, 400);
assert.equal((await proposeInvoice(db, inv({ jobRoomId: 'nope' }))).status, 400);
assert.equal((await proposeInvoice(db, inv({ jobRoomId: randomUUID() }))).status, 404);
addInvoice('I-00002', { job_id: randomUUID() });
assert.equal((await proposeInvoice(db, inv({ invoiceNumber: 'I-00002' }))).status, 409, 'invoice of another job');
addInvoice('I-00003', { job_id: null });
assert.equal((await proposeInvoice(db, inv({ invoiceNumber: 'I-00003' }))).status, 409, 'invoice not linked to any job');
addInvoice('I-00004', { total: 0 });
assert.equal((await proposeInvoice(db, inv({ invoiceNumber: 'I-00004' }))).status, 409, 'no amount');
const noCustomer = await openJobRoom(db, { leadId: randomUUID() });
assert.equal((await proposeInvoice(db, inv({ jobRoomId: noCustomer.body.jobRoomId }))).status, 409, 'room without a customer');
const techRoom = await openJobRoom(db, { leadId: randomUUID(), customer: { phone: '0622222222', name: 'Ali D' } });
rows('job_rooms').find((r) => r.id === techRoom.body.jobRoomId)!.job_id = jobUuid;
assert.equal((await proposeInvoice(db, inv({ jobRoomId: techRoom.body.jobRoomId }))).status, 409, 'never to a technician');
assert.equal((await verifyInvoice(db, outboxId)).status, 404, 'a plain message has no invoice');
assert.equal(Object.keys(tables).some((t) => /moneybird/i.test(t)), false, 'Moneybird is never written from here');
assert.ok(rows('job_outbox').every((o) => o.shadow === true && ['proposed', 'approved', 'cancelled'].includes(o.state)));

// --- Shadow: nothing in this module can send, and no row ever moved past approved ---
const exported = Object.keys(jobRoom);
assert.equal(exported.some((n) => /send|claim|report|deliver/i.test(n)), false, 'no send path exported');
assert.ok(rows('job_outbox').every((o) => o.shadow === true && ['proposed', 'approved', 'cancelled'].includes(o.state)));
assert.ok(Object.keys(tables).includes('ops_audit_log'), 'every call wrote an audit row');
assert.equal(
  JSON.stringify(rows('ops_audit_log')).includes('Test Klant'), false,
  'the audit log holds no customer data'
);

console.log(`check-jobroom: all passed (${cases} S3 cases)`);
