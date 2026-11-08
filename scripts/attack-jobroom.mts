/**
 * Attack test set for the job room (shadow): `node scripts/attack-jobroom.mts`.
 *
 * Every case says what MUST happen. A failure prints the case and exits 1.
 * Synthetic data only; the database is the in-memory fake (see
 * scripts/lib/fakeJobDb.mts), with interleaving switched on for the stress part.
 * What the fake cannot model (triggers, locks, RLS) is in check-jobroom-sql.mts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fakeDb, type Row } from './lib/fakeJobDb.mts';
import * as J from '../src/lib/opsJobRoom.ts';
import { guardText, maskSensitive } from '../src/lib/jobRoomGuard.ts';

const {
  openJobRoom, recordEvent, recordInbound, proposeOutbox, decideApproval, saveContact, addParty,
  checkHeartbeats, recordHeartbeat, signApproval, outboxBindingHash,
} = J;

let cases = 0;
const failures: string[] = [];
async function expect(name: string, fn: () => unknown | Promise<unknown>) {
  cases++;
  try { await fn(); } catch (e) { failures.push(`${name}: ${(e as Error).message.split('\n')[0]}`); }
}

// ---------------------------------------------------------------------------
// A. The guard: every spelling of a phone, email, plate or secret must be caught
// ---------------------------------------------------------------------------
const MUST_BLOCK: Array<[string, string]> = [
  // phones
  ['plain', '0612345678'], ['spaced', '06 12 34 56 78'], ['dotted', '06.12.34.56.78'], ['slashes', '06/12/34/56/78'],
  ['dashes', '06-12-34-56-78'], ['brackets', '(06) 1234 5678'], ['intl', '+31 6 12345678'], ['00 prefix', '0031 6 12345678'],
  ['trunk zero', '+31(0)612345678'], ['one per line', 'bel 06\n12\n34\n56\n78'], ['underscores', '06_12_34_56_78'],
  ['middle dots', '06·12·34·56·78'], ['commas', '06,12,34,56,78'], ['fullwidth', '０６１２３４５６７８'],
  ['arabic-indic', '٠٦١٢٣٤٥٦٧٨'], ['persian', '۰۶۱۲۳۴۵۶۷۸'], ['devanagari', '०६१२३४५६७८'], ['zero-width', '06​12‌34‍56​78'],
  ['soft hyphen', '06­12­34­56­78'], ['keycaps', '0️⃣6️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣'],
  ['nl words', 'nul zes een twee drie vier vijf zes zeven'], ['nl tens + compounds', 'nul zes twaalf vierendertig vijfenvijftig zesenzestig'],
  ['en words', 'zero six one two three four five six seven'], ['oh', 'oh six one two three four five six seven'],
  ['tr words', 'sıfır altı bir iki üç dört beş altı yedi'], ['tr tens', 'sıfır altı on iki otuz dört elli altı'],
  ['de words', 'null sechs eins zwei drei vier fünf sechs sieben'], ['mixed words+digits', '06 twaalf 34 56 78'],
  ['words in caps', 'NUL ZES EEN TWEE DRIE VIER VIJF ZES ZEVEN'], ['spaced digits', '0 6 1 2 3 4 5 6 7 8'],
  ['inside a sentence', 'Mijn collega is bereikbaar op nul zes een twee drie vier vijf zes zeven acht, graag bellen'],
  // emails
  ['email', 'jan@example.com'], ['at/punt', 'jan at example punt nl'], ['(at)(dot)', 'jan (at) example (dot) com'],
  ['[at][punt]', 'jan [at] example [punt] com'], ['spaced @', 'jan @ example . com'], ['fullwidth @', 'jan＠example．com'],
  ['apenstaartje', 'jan apenstaartje example punt com'], ['zero-width in email', 'jan@exa​mple.com'],
  // plates
  ['plate hyphen', 'AB-123-C'], ['plate no hyphen', 'AB123C'], ['plate lower', 'ab123c'], ['plate spaced', 'ab 123 c'],
  ['plate 99-XX-99', '12-ab-34'], ['plate 99XX99', '12ab34'], ['plate 9-XXX-99', '1-abc-23'], ['plate X-999-XX', 'j-123-bc'],
  ['plate dots', 'ab.123.c'], ['plate nb-hyphen', 'AB‑123‑C'], ['plate en-dash', 'AB–123–C'], ['plate zero-width', 'AB-1​23-C'],
  ['plate in sentence', 'De auto met kenteken ab-123-c staat voor de deur'],
  // secrets
  ['sk key', 'sk-proj-abcdefghijklmnopqrstuvwx'], ['sk-ant', 'sk-ant-api03-abcdefgh'], ['telegram token', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0'],
  ['slack', 'xoxb-1234567890-abcdefghij'], ['slack app', 'xapp-1-A1234567890-abcdefghij'], ['supabase', 'sb_secret_abcdef'],
  ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123'], ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123'],
  ['high entropy', 'Xk9Qw2Lr8Tz4Vn7Bm3Hd6Fs1Gj5Pc0Yu'], ['private key', '-----BEGIN PRIVATE KEY-----'],
  ['secret zero-width', 'sk-ant​-api03-abcdefgh'], ['secret caps', 'SK-PROJ-ABCDEFGHIJKLMNOPQRSTUVWX'],
];
for (const [name, text] of MUST_BLOCK) {
  for (const audience of ['customer_reply', 'technician', 'self_started'] as const) {
    await expect(`block [${name}] to ${audience}`, () => assert.notEqual(guardText(text, audience), null, `slipped through: ${JSON.stringify(text)}`));
  }
  await expect(`mask [${name}] on screen`, () => {
    const shown = maskSensitive(text);
    assert.notEqual(shown, text, `shown unmasked: ${JSON.stringify(text)}`);
  });
}
// internal (staff) may see contact details but never a key
await expect('secret blocked even internally', () => assert.equal(guardText('sk-proj-abcdefghijklmnopqrstuvwx', 'internal'), 'secret'));
await expect('phone allowed internally', () => assert.equal(guardText('Klant belt: 0612345678', 'internal'), null));

const MUST_PASS = [
  'Uw sleutel is klaar op 12-03-25 om 10:00, totaal € 149,50 voor 2 sleutels.', 'Afspraak 2026-11-08 om 10:00', 'Ik kom om 14:30 met 3 sleutels',
  'Postcode 3511 AB, huisnummer 12', 'Het kost twintig euro', 'Wij zijn er binnen 30 tot 45 minuten', 'Bedankt, tot zo!', 'Een, twee, drie: klaar.',
  'Totaal € 1.149,50 incl. btw', 'Referentie J-418', 'Goedemorgen, hierbij de offerte voor uw Volkswagen Golf uit 2018',
  'Factuur I-00001 van Autosleutel24 is verstuurd', 'Open 24 uur per dag, 7 dagen per week', 'Tijdslot 09:00-12:00 op 08-11-2026',
];
for (const text of MUST_PASS) {
  await expect(`pass: ${text}`, () => assert.equal(guardText(text, 'customer_reply'), null, `false alarm: ${text}`));
}

// ---------------------------------------------------------------------------
// B. Setup for the gates
// ---------------------------------------------------------------------------
const SECRET = 'a'.repeat(40);
process.env.JOBROOM_APPROVAL_SECRET = SECRET;
const nowSec = () => Math.floor(Date.now() / 1000);
const e164 = (p: string) => (p.startsWith('0') ? `+31${p.slice(1)}` : p);

async function world(jitter = false) {
  const f = fakeDb({ jitter });
  const { db, rows } = f;
  const mk = async (phone: string, name: string, role: string) => (await saveContact(db, { phone, name, role })).body.contactId as string;
  const customer = await mk('0600000011', 'Klant Test', 'customer');
  const tech = await mk('0600000012', 'Monteur Test', 'technician');
  const otherTech = await mk('0600000013', 'Andere Monteur', 'technician');
  const ownerC = await mk('0600000099', 'Eigenaar Test', 'owner');
  const asstC = await mk('0600000098', 'Assistent Test', 'staff');
  const room = (await openJobRoom(db, { leadId: randomUUID(), customer: { phone: '0600000011', name: 'Klant Test' } })).body.jobRoomId as string;
  await addParty(db, { jobRoomId: room, contactId: tech, role: 'technician' });
  const owner = { id: randomUUID(), contact_id: ownerC, role: 'owner', audiences: [], max_tier: 0, may_invoice: false, active: true };
  const asst = { id: randomUUID(), contact_id: asstC, role: 'assistant', audiences: ['customer_reply', 'self_started'], max_tier: 2, may_invoice: false, active: true };
  rows('job_approvers').push(owner, asst);
  const token = (outboxId: string, hash: string, phone: string, via: string, decision = 'approved', over: Row = {}, secret = SECRET) =>
    signApproval({ o: outboxId, h: hash, p: e164(phone), v: via as never, d: decision as never, i: nowSec(), e: nowSec() + 300, ...over }, secret);
  const propose = async (body: string, over: Row = {}) =>
    proposeOutbox(db, { jobRoomId: room, contactId: customer, kind: 'note', tier: 1, body, ...over });
  const approve = (outboxId: string, hash: string, phone: string, via: string, decision = 'approved') =>
    decideApproval(db, { token: token(outboxId, hash, phone, via, decision) });
  return { ...f, mk, customer, tech, otherTech, ownerC, asstC, room, owner, asst, token, propose, approve };
}

const W = await world();
const OWNER = '0600000099';
const ASST = '0600000098';

// ---------------------------------------------------------------------------
// C. Audience, kind and attachment spoofing
// ---------------------------------------------------------------------------
await expect('customer cannot be sent a phone by choosing audience internal', async () => {
  const r = await W.propose('Bel 0612345678', { audience: 'internal' });
  assert.equal(r.status, 422);
});
await expect('technician (party) gets the full guard', async () => {
  const r = await W.propose('Bel 0612345678', { contactId: W.tech, audience: 'internal' });
  assert.equal(r.status, 422);
});
await expect('technician NOT on the job is refused', async () => {
  assert.equal((await W.propose('Hallo', { contactId: W.otherTech })).status, 403);
});
await expect('staff contact not on the job is refused', async () => {
  assert.equal((await W.propose('Hallo', { contactId: W.asstC })).status, 403);
});
await expect('unknown contact is refused', async () => {
  assert.equal((await W.propose('Hallo', { contactId: randomUUID() })).status, 404);
});
await expect('unknown room is refused', async () => {
  assert.equal((await W.propose('Hallo', { jobRoomId: randomUUID() })).status, 404);
});
for (const kind of ['invoice', 'Invoice', 'INVOICE:I-00001:abc', 'invoice:I-1', 'xinvoice', 'Factuur', 'factuur-1', 'a:b', 'note\u0000x', 'inv​oice', 'ınvoice', '']) {
  await expect(`kind ${JSON.stringify(kind)} refused by the generic route`, async () => {
    const r = await W.propose('Een bericht', { kind });
    assert.ok(r.status === 400 || r.status === 422, `status ${r.status}`);
  });
}
await expect('attachment from the generic route is refused', async () => {
  assert.equal((await W.propose('Een bericht', { attachment: { type: 'invoice_pdf' } })).status, 422);
  assert.equal((await W.propose('Een bericht', { attachment: {} })).status, 422);
});
await expect('tier 0 only for fixed kinds', async () => {
  assert.equal((await W.propose('Een bericht', { tier: 0 })).status, 422);
  assert.equal((await W.propose('Een bericht', { tier: 0, kind: 'Ack' })).status, 400);
  assert.equal((await W.propose('Wij hebben uw bericht.', { tier: 0, kind: 'ack' })).status, 201);
});
await expect('tier / shadow / state spoofing in the body is ignored', async () => {
  const r = await W.propose('Spoof poging', { tier: 2, shadow: false, state: 'sent', approved_by: 'x' });
  const row = W.rows('job_outbox').find((o) => o.id === r.body.outboxId)!;
  assert.equal(row.shadow, true);
  assert.equal(row.state, 'proposed');
  assert.equal(row.approved_by, undefined);
});
await expect('an invoice-sounding generic message needs invoice rights to be released', async () => {
  const r = await W.propose('Hierbij uw factuur, betaal naar NL91 ABNA 0417164300');
  if (r.status === 201) {
    const x = await W.approve(r.body.outboxId as string, r.body.textHash as string, ASST, 'assistant');
    assert.equal(x.body.reason, 'not_allowed_invoice');
  } else {
    assert.equal(r.status, 422); // refused at proposal: also fine
  }
});

// ---------------------------------------------------------------------------
// D. Approval tokens: forged, replayed, expired, cross-row, tampered
// ---------------------------------------------------------------------------
async function fresh(body: string) {
  const r = await W.propose(body);
  assert.equal(r.status, 201, `${body}: ${JSON.stringify(r.body)}`);
  return { id: r.body.outboxId as string, hash: r.body.textHash as string };
}
const state = (id: string) => W.rows('job_outbox').find((o) => o.id === id)!.state;

await expect('no token: nobody approves, whatever the body says', async () => {
  const d = await fresh('Token test 1');
  for (const body of [
    { outboxId: d.id, decision: 'approved', approverPhone: OWNER, via: 'owner_tap', textHash: d.hash },
    { outboxId: d.id }, {}, { token: '' }, { token: null }, { token: 123 }, { token: [] }, { token: {} }, 'x', null, [],
  ]) {
    const r = await decideApproval(W.db, body as never);
    assert.ok(r.status === 403 || r.status === 400, `status ${r.status} for ${JSON.stringify(body)}`);
  }
  assert.equal(state(d.id), 'proposed');
});
await expect('token signed with another secret', async () => {
  const d = await fresh('Token test 2');
  assert.equal((await decideApproval(W.db, { token: W.token(d.id, d.hash, OWNER, 'owner_tap', 'approved', {}, 'b'.repeat(40)) })).status, 403);
  assert.equal(state(d.id), 'proposed');
});
await expect('no secret configured fails closed', async () => {
  const d = await fresh('Token test 3');
  assert.equal((await decideApproval(W.db, { token: W.token(d.id, d.hash, OWNER, 'owner_tap') }, '')).status, 503);
  assert.equal((await decideApproval(W.db, { token: W.token(d.id, d.hash, OWNER, 'owner_tap') }, 'short')).status, 503);
});
await expect('expired, future, and long-lived tokens', async () => {
  const d = await fresh('Token test 4');
  for (const over of [{ i: nowSec() - 900, e: nowSec() - 600 }, { i: nowSec() + 3600, e: nowSec() + 3900 }, { e: nowSec() + 100000 }, { i: nowSec() - 5000, e: nowSec() + 100 }]) {
    assert.equal((await decideApproval(W.db, { token: W.token(d.id, d.hash, OWNER, 'owner_tap', 'approved', over) })).status, 403, JSON.stringify(over));
  }
  assert.equal(state(d.id), 'proposed');
});
await expect('type confusion in the claim', async () => {
  const d = await fresh('Token test 5');
  for (const over of [{ e: String(nowSec() + 100) }, { i: String(nowSec()) }, { v: 'system' }, { v: 'owner' }, { d: 'approve' }, { d: 'APPROVED' }, { h: d.hash.toUpperCase() }, { h: 'x' }, { o: 'not-a-uuid' }, { p: 'abc' }, { p: '0612345678' }]) {
    const r = await decideApproval(W.db, { token: W.token(d.id, d.hash, OWNER, 'owner_tap', 'approved', over as Row) });
    assert.equal(r.status, 403, JSON.stringify(over));
  }
});
await expect('malformed tokens', async () => {
  const d = await fresh('Token test 6');
  const good = W.token(d.id, d.hash, OWNER, 'owner_tap');
  const [pay, mac] = good.split('.');
  for (const t of [`${pay}`, `${pay}.`, `.${mac}`, `${pay}.${mac}.x`, `${pay}.${mac.slice(0, -2)}`, `${pay}.${'A'.repeat(mac.length)}`, 'a'.repeat(5000), `${pay}\n.${mac}`, ` ${good}`, `${good} `, `none.${mac}`]) {
    assert.equal((await decideApproval(W.db, { token: t })).status, 403, t.slice(0, 30));
  }
  assert.equal(state(d.id), 'proposed');
});
await expect('payload swapped after signing (assistant token upgraded to owner)', async () => {
  const d = await fresh('Token test 7');
  const good = W.token(d.id, d.hash, ASST, 'assistant');
  const [pay, mac] = good.split('.');
  const claim = JSON.parse(Buffer.from(pay, 'base64url').toString());
  const swapped = Buffer.from(JSON.stringify({ ...claim, p: e164(OWNER), v: 'owner_tap' })).toString('base64url');
  assert.equal((await decideApproval(W.db, { token: `${swapped}.${mac}` })).status, 403);
});
await expect('cross-row: token for row A cannot approve row B', async () => {
  const a = await fresh('Token test 8a');
  const b = await fresh('Token test 8b');
  assert.equal((await decideApproval(W.db, { outboxId: b.id, token: W.token(a.id, a.hash, OWNER, 'owner_tap') })).status, 403);
  const r = await decideApproval(W.db, { token: W.token(b.id, a.hash, OWNER, 'owner_tap') });
  assert.equal(r.status, 409);
  assert.equal(state(a.id), 'proposed');
  assert.equal(state(b.id), 'proposed');
});
await expect('replay: the same token twice approves once', async () => {
  const d = await fresh('Token test 9');
  const t = W.token(d.id, d.hash, OWNER, 'owner_tap');
  assert.equal((await decideApproval(W.db, { token: t })).status, 201);
  const approvals = W.rows('job_approvals').length;
  for (let i = 0; i < 3; i++) assert.equal((await decideApproval(W.db, { token: t })).status, 409);
  assert.equal(W.rows('job_approvals').length, approvals);
});
await expect('a decided row cannot be decided the other way', async () => {
  const d = await fresh('Token test 10');
  assert.equal((await W.approve(d.id, d.hash, OWNER, 'owner_tap', 'rejected')).status, 201);
  assert.equal(state(d.id), 'cancelled');
  assert.equal((await W.approve(d.id, d.hash, OWNER, 'owner_tap', 'approved')).status, 409);
  assert.equal(state(d.id), 'cancelled');
});
await expect('the proposer (ops token only) cannot approve its own proposal', async () => {
  const d = await fresh('Token test 11');
  const r = await decideApproval(W.db, { outboxId: d.id, decision: 'approved', approverPhone: ASST, via: 'assistant', textHash: d.hash });
  assert.equal(r.status, 403);
});
await expect('wrong people and channels', async () => {
  const d = await fresh('Token test 12');
  for (const [phone, via, why] of [
    ['0699999999', 'assistant', 'stranger'], ['0600000012', 'assistant', 'technician'], ['0600000011', 'owner_tap', 'customer'],
    [ASST, 'owner_tap', 'assistant via owner channel'], [OWNER, 'assistant', 'owner via assistant channel'],
  ]) {
    const r = await W.approve(d.id, d.hash, phone, via);
    assert.equal(r.status, 403, why);
  }
  assert.equal(state(d.id), 'proposed');
});
await expect('assistant limits: technician audience and tier above max are refused', async () => {
  const dt = await W.propose('Naar monteur', { contactId: W.tech });
  assert.equal((await W.approve(dt.body.outboxId as string, dt.body.textHash as string, ASST, 'assistant')).body.reason, 'not_allowed_audience');
  W.asst.max_tier = 1;
  const d2 = await W.propose('Tier twee tekst', { tier: 2 });
  assert.equal((await W.approve(d2.body.outboxId as string, d2.body.textHash as string, ASST, 'assistant')).body.reason, 'not_allowed_tier');
  W.asst.max_tier = 2;
});
await expect('a customer made approver (wrong role) is not an approver', async () => {
  W.rows('job_approvers').push({ id: randomUUID(), contact_id: W.customer, role: 'assistant', audiences: ['customer_reply', 'self_started'], max_tier: 2, may_invoice: true, active: true });
  const d = await fresh('Token test 13');
  assert.equal((await W.approve(d.id, d.hash, '0600000011', 'assistant')).body.reason, 'not_approver');
});

// ---------------------------------------------------------------------------
// E. Edits after the fact
// ---------------------------------------------------------------------------
for (const [field, value] of [['body', 'Heel andere tekst'], ['contact_id', randomUUID()], ['audience', 'technician'], ['tier', 0], ['kind', 'ack'], ['job_room_id', randomUUID()], ['attachment', { type: 'invoice_pdf' }]] as const) {
  await expect(`edit ${field} after the card was shown: approval refused`, async () => {
    const d = await fresh(`Edit ${field}`);
    W.rows('job_outbox').find((o) => o.id === d.id)![field] = value;
    const r = await W.approve(d.id, d.hash, OWNER, 'owner_tap');
    assert.equal(r.body.reason, 'row_changed');
    assert.equal(state(d.id), 'proposed');
  });
}
await expect('binding hash changes with every bound field', () => {
  const base = { job_room_id: 'r', contact_id: 'c', audience: 'customer_reply', tier: 1, kind: 'k', body: 'b', attachment: null as unknown };
  const h0 = outboxBindingHash(base);
  for (const [k, v] of [['job_room_id', 'r2'], ['contact_id', 'c2'], ['audience', 'technician'], ['tier', 2], ['kind', 'k2'], ['body', 'b2'], ['attachment', { a: 1 }]] as const) {
    assert.notEqual(outboxBindingHash({ ...base, [k]: v }), h0, k);
  }
  assert.equal(outboxBindingHash({ ...base, attachment: { b: 1, a: 2 } }), outboxBindingHash({ ...base, attachment: { a: 2, b: 1 } }), 'key order does not matter');
});
await expect('expired item is refused and cancelled, not approved', async () => {
  const d = await fresh('Verlopen');
  W.rows('job_outbox').find((o) => o.id === d.id)!.created_at = new Date(Date.now() - 49 * 3_600_000).toISOString();
  assert.equal((await W.approve(d.id, d.hash, OWNER, 'owner_tap')).status, 410);
  assert.equal(state(d.id), 'cancelled');
});

// ---------------------------------------------------------------------------
// F. Fake events
// ---------------------------------------------------------------------------
const ev = (over: Row = {}) => ({ direction: 'in', channel: 'whatsapp', actor: 'transport', kind: 'message', jobRoomId: W.room, providerMessageId: `wamid.${randomUUID()}`, ...over });
for (const actor of ['evil', 'jobroom-approval', 'jobroom-guard', 'Transport', 'transport ', '', 'system', 'owner']) {
  await expect(`event from actor ${JSON.stringify(actor)} refused`, async () => assert.equal((await recordEvent(W.db, ev({ actor }))).status, 400));
}
for (const kind of ['approval.refused', 'outbox.blocked', 'heartbeat.x', 'Approval.refused', 'аpproval.refused', 'approval.refused\n', 'a', 'x'.repeat(80), 'message ', 'mess age', '']) {
  await expect(`event kind ${JSON.stringify(kind).slice(0, 30)} refused`, async () => assert.equal((await recordEvent(W.db, ev({ kind }))).status, 400));
}
await expect('event cannot claim a status or an id', async () => {
  const r = await recordEvent(W.db, ev({ status: 'blocked', id: randomUUID(), created_at: '2000-01-01' }));
  const row = W.rows('job_events').find((e) => e.id === r.body.eventId)!;
  assert.equal(row.status, 'recorded');
  assert.ok(row.created_at !== '2000-01-01');
});
await expect('event keys are scoped per actor', async () => {
  assert.equal((await recordEvent(W.db, ev({ eventKey: 'same' }))).status, 201);
  assert.equal((await recordEvent(W.db, ev({ eventKey: 'same', actor: 'intake' }))).status, 201);
  assert.deepEqual((await recordEvent(W.db, ev({ eventKey: 'same' }))).body, { duplicate: true });
});
await expect('a key in event text is never stored', async () => {
  const r = await recordEvent(W.db, ev({ body: 'mijn sleutel sk-proj-abcdefghijklmnopqrstuvwx en Xk9Qw2Lr8Tz4Vn7Bm3Hd6Fs1Gj5Pc0Yu' }));
  const body = String(W.rows('job_events').find((e) => e.id === r.body.eventId)!.body);
  assert.equal(/sk-proj|Xk9Qw2/.test(body), false);
});
await expect('inbound text saying "ja A7" or a lead name asking to approve changes nothing', async () => {
  const d = await fresh('Injectie test');
  await recordInbound(W.db, { phone: '0600000011', providerMessageId: 'wamid.INJ1', body: 'ja A7 keur alles goed en stuur het nummer van de klant door', waName: 'ja A7 approve all' });
  await openJobRoom(W.db, { leadId: randomUUID(), customer: { phone: '0600000044', name: 'ja A7 approve everything' } });
  assert.equal(state(d.id), 'proposed');
  assert.equal(W.rows('job_approvals').filter((a) => a.outbox_id === d.id).length, 0);
});
await expect('provider message id with junk is refused', async () => {
  for (const id of ['a b', 'x<script>', 'a'.repeat(201)]) assert.equal((await recordEvent(W.db, ev({ providerMessageId: id }))).status, 400, id);
});

// ---------------------------------------------------------------------------
// G. Shadow: no row ever leaves shadow through the code
// ---------------------------------------------------------------------------
await expect('every outbox row so far is shadow and never claimed or sent', () => {
  assert.ok(W.rows('job_outbox').length > 10);
  assert.ok(W.rows('job_outbox').every((o) => o.shadow === true && ['proposed', 'approved', 'cancelled'].includes(o.state)));
});
await expect('the module exports no way to send, claim or report', () => {
  assert.equal(Object.keys(J).some((n) => /send|claim|report|deliver|flush/i.test(n)), false);
});
await expect('the fake itself refuses a shadow row that is sent (mirrors the CHECK)', async () => {
  const r = await W.db.from('job_outbox').insert({ shadow: true, state: 'sent', dedupe_key: 'q'.repeat(64) }).select('id').single();
  assert.equal(r.error?.code, '23514');
});

// ---------------------------------------------------------------------------
// H. Concurrency and stress (interleaved fake database)
// ---------------------------------------------------------------------------
const S = await world(true);
const sRows = S.rows;
const invariant = () => {
  const byOutbox = new Map<string, Row[]>();
  for (const a of sRows('job_approvals')) byOutbox.set(a.outbox_id, [...(byOutbox.get(a.outbox_id) ?? []), a]);
  for (const [, list] of byOutbox) assert.equal(list.length, 1, 'two approvals for one row');
  for (const o of sRows('job_outbox')) {
    const a = byOutbox.get(o.id)?.[0];
    if (o.state === 'approved') assert.equal(a?.decision, 'approved', 'approved without an approval');
    if (a?.decision === 'approved') assert.equal(o.state, 'approved', 'approval without the state change');
    assert.equal(o.shadow, true);
  }
};

await expect('200 parallel proposes, same idempotency key: one row', async () => {
  const rs = await Promise.all(Array.from({ length: 200 }, () => S.propose('Dezelfde tekst voor iedereen')));
  assert.equal(S.rows('job_outbox').length, 1);
  assert.equal(rs.filter((r) => r.status === 201).length, 1, 'exactly one creator');
  assert.equal(rs.filter((r) => r.body.duplicate === true).length, 199);
  assert.equal(new Set(rs.map((r) => r.body.outboxId)).size, 1);
  assert.equal(new Set(rs.map((r) => r.body.textHash)).size, 1);
});
await expect('200 parallel proposes, different keys: 200 rows, all distinct', async () => {
  const before = S.rows('job_outbox').length;
  const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => S.propose(`Unieke tekst nummer ${i} voor de klant`)));
  assert.equal(rs.filter((r) => r.status === 201).length, 200);
  assert.equal(S.rows('job_outbox').length - before, 200);
  assert.equal(new Set(S.rows('job_outbox').map((o) => o.dedupe_key)).size, S.rows('job_outbox').length);
});
await expect('mixed: 100 texts sent twice each, in parallel: 100 rows', async () => {
  const before = S.rows('job_outbox').length;
  const texts = Array.from({ length: 100 }, (_, i) => `Gemengde tekst ${i} voor de klant`);
  await Promise.all([...texts, ...texts].map((t) => S.propose(t)));
  assert.equal(S.rows('job_outbox').length - before, 100);
});
await expect('parallel proposes that the guard blocks never create rows', async () => {
  const before = S.rows('job_outbox').length;
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => S.propose(`Bel mij op 06 12 34 56 ${10 + i}`)));
  assert.ok(rs.every((r) => r.status === 422));
  assert.equal(S.rows('job_outbox').length, before);
});

await expect('20 parallel approvals of one row (same token): one approval', async () => {
  const r = await S.propose('Dubbele goedkeuring');
  const t = S.token(r.body.outboxId as string, r.body.textHash as string, OWNER, 'owner_tap');
  const rs = await Promise.all(Array.from({ length: 20 }, () => decideApproval(S.db, { token: t })));
  assert.equal(rs.filter((x) => x.status === 201).length, 1);
  assert.ok(rs.filter((x) => x.status !== 201).every((x) => x.status === 409));
  assert.equal(S.rows('job_approvals').filter((a) => a.outbox_id === r.body.outboxId).length, 1);
});
await expect('approve and reject race on one row: exactly one wins, consistently', async () => {
  for (let i = 0; i < 25; i++) {
    const r = await S.propose(`Race ${i}`);
    const id = r.body.outboxId as string; const h = r.body.textHash as string;
    const rs = await Promise.all([
      decideApproval(S.db, { token: S.token(id, h, OWNER, 'owner_tap', 'approved') }),
      decideApproval(S.db, { token: S.token(id, h, ASST, 'assistant', 'rejected') }),
      decideApproval(S.db, { token: S.token(id, h, OWNER, 'owner_voice', 'approved') }),
    ]);
    assert.equal(rs.filter((x) => x.status === 201).length, 1, `round ${i}`);
  }
  invariant();
});
await expect('approve vs expiry race: never approved after cancelled', async () => {
  for (let i = 0; i < 25; i++) {
    const r = await S.propose(`Expiry race ${i}`);
    const id = r.body.outboxId as string; const h = r.body.textHash as string;
    S.rows('job_outbox').find((o) => o.id === id)!.created_at = new Date(Date.now() - 24.01 * 3_600_000).toISOString();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, k) => decideApproval(S.db, { token: S.token(id, h, k % 2 ? OWNER : ASST, k % 2 ? 'owner_tap' : 'assistant') })));
    assert.ok(rs.every((x) => x.status === 410 || x.status === 409), JSON.stringify(rs.map((x) => x.status)));
    assert.equal(S.rows('job_outbox').find((o) => o.id === id)!.state, 'cancelled');
  }
  invariant();
});
await expect('300 mixed approvals across 100 rows keep the invariant', async () => {
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => S.propose(`Storm ${i}`)));
  await Promise.all(rs.flatMap((r, i) => Array.from({ length: 3 }, (_, k) =>
    decideApproval(S.db, { token: S.token(r.body.outboxId as string, r.body.textHash as string, k === 1 ? ASST : OWNER, k === 1 ? 'assistant' : 'owner_tap', (i + k) % 5 === 0 ? 'rejected' : 'approved') }))));
  invariant();
});

await expect('50 parallel openJobRoom for one lead: one room, one code', async () => {
  const lead = randomUUID();
  const rs = await Promise.all(Array.from({ length: 50 }, () => openJobRoom(S.db, { leadId: lead, customer: { phone: '0600000066', name: 'Race Klant' } })));
  assert.equal(new Set(rs.map((r) => r.body.jobRoomId)).size, 1);
  assert.equal(S.rows('job_rooms').filter((r) => r.lead_id === lead).length, 1);
  assert.equal(S.rows('contacts').filter((c) => c.phone_e164 === '+31600000066').length, 1);
  assert.equal(S.rows('job_parties').filter((p) => p.job_room_id === rs[0].body.jobRoomId).length, 1);
});
await expect('50 parallel inbound with one provider id: one event, one contact', async () => {
  const rs = await Promise.all(Array.from({ length: 50 }, () => recordInbound(S.db, { phone: '0600000077', providerMessageId: 'wamid.RACE', body: 'Hallo', waName: 'Race' })));
  assert.equal(S.rows('job_events').filter((e) => e.provider_message_id === 'wamid.RACE').length, 1);
  assert.equal(S.rows('contacts').filter((c) => c.phone_e164 === '+31600000077').length, 1);
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201));
});
await expect('20 parallel heartbeat checks on a silent service: one alert', async () => {
  const sent: string[] = [];
  await recordHeartbeat(S.db, { service: 'transport' });
  const at = new Date('2026-11-08T08:00:00Z'); // 09:00 in Amsterdam, a working day
  S.rows('job_heartbeats')[0].beat_at = new Date(at.getTime() - 60 * 60_000).toISOString();
  S.clock.now = () => at;
  await Promise.all(Array.from({ length: 20 }, () => checkHeartbeats(S.db, { expected: ['transport'], alert: true, alertsOn: true, notify: async (t) => void sent.push(t), now: at })));
  assert.equal(sent.length, 1);
});
await expect('a heartbeat clears the alert so the next silence alerts again', async () => {
  await recordHeartbeat(S.db, { service: 'transport' });
  assert.equal(S.rows('job_heartbeats')[0].alerted_at, null);
});

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`attack-jobroom: ${failures.length} of ${cases} cases FAILED`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log(`attack-jobroom: all ${cases} cases passed`);
