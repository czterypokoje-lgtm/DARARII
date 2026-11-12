/**
 * Checks behind the click-id matcher: `node scripts/check-attribution.mts`.
 * Plain node, fixtures, no network, no real numbers or click ids.
 *
 * What it guards: a recovered click id goes to Google and steers the bidding.
 * A wrong match (two clicks, a click after the job, a number that only looks
 * alike) costs money; a phone number leaking into the file costs privacy.
 */
import assert from 'node:assert/strict';
import {
  attributionStats,
  clickOf,
  phoneKey,
  recoverClicks,
  resolveJobClick,
  weekStartAmsterdam,
  type AttrClick,
  type AttrJob,
  type AttrLead,
  type AttrPool,
} from '../src/lib/adAttribution.ts';
import { buildAdsFeed, type FeedJobRow } from '../src/lib/adsConversionsFeed.ts';

let n = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    n++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
};

const G1 = 'Cj0KCQiA_fixture-gclid1';
const G2 = 'Cj0KCQiA_fixture-gclid2';
const GB = '0AAAAAD_fixture_gbraid1';
const WB = '0AAAAAD_fixture_wbraid1';
const PHONE = '+31 6 1234 5678';

const job = (over: Partial<AttrJob> = {}): AttrJob => ({
  id: 'job-1',
  status: 'afgerond',
  completed_at: '2026-11-05T10:00:00Z',
  lead_id: null,
  customer_phone: '0612345678',
  gclid: null,
  wbraid: null,
  gbraid: null,
  ...over,
});
const lead = (over: Partial<AttrLead> = {}): AttrLead => ({
  id: 'lead-1',
  phone: '06-12345678',
  phone_e164: '+31612345678',
  created_at: '2026-11-01T08:00:00Z',
  gclid: G1,
  wbraid: null,
  gbraid: null,
  ...over,
});
const click = (over: Partial<AttrClick> = {}): AttrClick => ({
  id: 'click-1',
  ref: null,
  created_at: '2026-11-02T08:00:00Z',
  claimed_by_job_id: null,
  gclid: G1,
  wbraid: null,
  gbraid: null,
  ...over,
});
const pool = (over: Partial<AttrPool> = {}): AttrPool => ({ leads: [], clicks: [], chats: [], ...over });
const recovered = (j: AttrJob, p: AttrPool) => {
  const r = resolveJobClick(j, p);
  assert.equal(r.status, 'recovered');
  return r.status === 'recovered' ? r.click : (null as never);
};

/* phone keys */
check('06 local format', () => assert.equal(phoneKey('0612345678'), '612345678'));
check('+31 with spaces', () => assert.equal(phoneKey('+31 6 1234 5678'), '612345678'));
check('0031 prefix', () => assert.equal(phoneKey('0031612345678'), '612345678'));
check('31 without plus', () => assert.equal(phoneKey('31612345678'), '612345678'));
check('dashes and brackets', () => assert.equal(phoneKey('(+31)-6-12345678'), '612345678'));
check('+31 (0) 6 form', () => assert.equal(phoneKey('+31 (0)6 12345678'), '612345678'));
check('too short is no key', () => assert.equal(phoneKey('12345678'), null));
check('empty and null are no key', () => {
  assert.equal(phoneKey(''), null);
  assert.equal(phoneKey(null), null);
  assert.equal(phoneKey(undefined), null);
});
check('different number, different key', () => assert.notEqual(phoneKey('0612345679'), phoneKey('0612345678')));

/* direct */
check('own click id is direct and untouched', () => {
  const r = resolveJobClick(job({ gclid: G2 }), pool({ leads: [lead({ id: 'x', phone: '0612345678' })] }));
  assert.deepEqual(r, { status: 'direct', kind: 'gclid' });
});
check('own gbraid is direct', () => assert.equal(resolveJobClick(job({ gbraid: GB }), pool()).status, 'direct'));
check('junk click id is not a click id', () => assert.equal(clickOf({ gclid: 'x y!' }), null));
check('click kind order gclid, gbraid, wbraid', () => assert.equal(clickOf({ wbraid: WB, gbraid: GB, gclid: G1 })?.kind, 'gclid'));

/* rule 1: lead link */
check('lead_link certain', () => {
  const c = recovered(job({ lead_id: 'lead-1' }), pool({ leads: [lead()] }));
  assert.equal(c.rule, 'lead_link');
  assert.equal(c.confidence, 'certain');
  assert.equal(c.id, G1);
  assert.equal(c.kind, 'gclid');
  assert.equal(c.clickedAt, '2026-11-01T08:00:00.000Z');
});
check('lead_link gbraid keeps its kind', () => {
  const c = recovered(job({ lead_id: 'lead-1' }), pool({ leads: [lead({ gclid: null, gbraid: GB })] }));
  assert.deepEqual([c.kind, c.id], ['gbraid', GB]);
});
check('lead without click id gives nothing', () =>
  assert.equal(resolveJobClick(job({ lead_id: 'lead-1' }), pool({ leads: [lead({ gclid: null })] })).status, 'none'));

/* rule 2: claimed click */
check('claimed_click certain', () => {
  const c = recovered(job(), pool({ clicks: [click({ claimed_by_job_id: 'job-1' })] }));
  assert.equal(c.rule, 'claimed_click');
  assert.equal(c.confidence, 'certain');
});
check('click claimed by another job is ignored', () =>
  assert.equal(resolveJobClick(job(), pool({ clicks: [click({ claimed_by_job_id: 'job-9' })] })).status, 'none'));
check('unclaimed click alone never matches by time', () =>
  assert.equal(resolveJobClick(job({ customer_phone: null }), pool({ clicks: [click()] })).status, 'none'));

/* rule 3: chat ref */
check('chat_ref certain, number in other format', () => {
  const c = recovered(job(), pool({ clicks: [click({ ref: 'K7F2' })], chats: [{ ref: 'K7F2', phone: '31612345678' }] }));
  assert.equal(c.rule, 'chat_ref');
  assert.equal(c.confidence, 'certain');
});
check('chat_ref code is case-insensitive', () =>
  assert.equal(recovered(job(), pool({ clicks: [click({ ref: 'k7f2' })], chats: [{ ref: 'K7F2', phone: PHONE }] })).rule, 'chat_ref'));
check('chat_ref other number does nothing', () =>
  assert.equal(
    resolveJobClick(job(), pool({ clicks: [click({ ref: 'K7F2' })], chats: [{ ref: 'K7F2', phone: '0687654321' }] })).status,
    'none'
  ));
check('chat_ref unknown code does nothing', () =>
  assert.equal(resolveJobClick(job(), pool({ clicks: [click({ ref: 'AAAA' })], chats: [{ ref: 'K7F2', phone: PHONE }] })).status, 'none'));
check('chat_ref click taken by another job is skipped', () =>
  assert.equal(
    resolveJobClick(job(), pool({ clicks: [click({ ref: 'K7F2', claimed_by_job_id: 'job-9' })], chats: [{ ref: 'K7F2', phone: PHONE }] })).status,
    'none'
  ));
check('chat_ref without a click id does nothing', () =>
  assert.equal(
    resolveJobClick(job(), pool({ clicks: [click({ ref: 'K7F2', gclid: null })], chats: [{ ref: 'K7F2', phone: PHONE }] })).status,
    'none'
  ));

/* rule 4: same phone on a lead */
check('phone_lead is likely', () => {
  const c = recovered(job(), pool({ leads: [lead()] }));
  assert.equal(c.rule, 'phone_lead');
  assert.equal(c.confidence, 'likely');
});
check('phone_lead matches via phone_e164 only', () =>
  assert.equal(recovered(job(), pool({ leads: [lead({ phone: null })] })).rule, 'phone_lead'));
check('phone_lead job has no phone', () =>
  assert.equal(resolveJobClick(job({ customer_phone: null }), pool({ leads: [lead()] })).status, 'none'));
check('phone_lead different number', () =>
  assert.equal(resolveJobClick(job(), pool({ leads: [lead({ phone: '0687654321', phone_e164: '+31687654321' })] })).status, 'none'));

/* ties */
check('two phone leads with two click ids: ambiguous', () => {
  const r = resolveJobClick(job(), pool({ leads: [lead(), lead({ id: 'lead-2', gclid: G2 })] }));
  assert.equal(r.status, 'ambiguous');
});
check('two phone leads with the same click id: recovered', () =>
  assert.equal(recovered(job(), pool({ leads: [lead(), lead({ id: 'lead-2' })] })).id, G1));
check('certain beats likely when ids differ', () => {
  const c = recovered(job({ lead_id: 'lead-1' }), pool({ leads: [lead(), lead({ id: 'lead-2', gclid: G2 })] }));
  assert.equal(c.id, G1);
  assert.equal(c.rule, 'lead_link');
});
check('two certain rules, two different ids: ambiguous', () => {
  const r = resolveJobClick(
    job({ lead_id: 'lead-1' }),
    pool({ leads: [lead()], clicks: [click({ claimed_by_job_id: 'job-1', gclid: G2 })] })
  );
  assert.equal(r.status, 'ambiguous');
});
check('two certain rules, same id: strongest rule reported', () => {
  const c = recovered(job({ lead_id: 'lead-1' }), pool({ leads: [lead()], clicks: [click({ claimed_by_job_id: 'job-1' })] }));
  assert.equal(c.rule, 'lead_link');
});
check('two chat refs to two clicks: ambiguous', () => {
  const r = resolveJobClick(
    job(),
    pool({
      clicks: [click({ ref: 'K7F2' }), click({ id: 'click-2', ref: 'M3N4', gclid: G2 })],
      chats: [{ ref: 'K7F2', phone: PHONE }, { ref: 'M3N4', phone: PHONE }],
    })
  );
  assert.equal(r.status, 'ambiguous');
});

/* the 90-day window */
check('click exactly 90 days before the job counts', () =>
  assert.equal(recovered(job({ lead_id: 'lead-1', completed_at: '2026-11-05T10:00:00Z' }), pool({ leads: [lead({ created_at: '2026-08-07T10:00:00Z' })] })).rule, 'lead_link'));
check('click one second older than 90 days is ignored', () =>
  assert.equal(resolveJobClick(job({ lead_id: 'lead-1' }), pool({ leads: [lead({ created_at: '2026-08-07T09:59:59Z' })] })).status, 'none'));
check('click later than the job is ignored', () =>
  assert.equal(resolveJobClick(job({ lead_id: 'lead-1' }), pool({ leads: [lead({ created_at: '2026-11-05T10:00:01Z' })] })).status, 'none'));
check('click at the very moment of the job counts', () =>
  assert.equal(resolveJobClick(job({ lead_id: 'lead-1' }), pool({ leads: [lead({ created_at: '2026-11-05T10:00:00Z' })] })).status, 'recovered'));
check('window applies to claimed clicks too', () =>
  assert.equal(resolveJobClick(job(), pool({ clicks: [click({ claimed_by_job_id: 'job-1', created_at: '2026-06-01T00:00:00Z' })] })).status, 'none'));
check('window applies to phone leads; a second in-window lead wins alone', () => {
  const c = recovered(job(), pool({ leads: [lead({ created_at: '2026-01-01T00:00:00Z', gclid: G2 }), lead({ id: 'lead-2' })] }));
  assert.equal(c.id, G1);
});
check('job without completion time gets nothing', () =>
  assert.equal(resolveJobClick(job({ completed_at: null, lead_id: 'lead-1' }), pool({ leads: [lead()] })).status, 'none'));

/* recoverClicks */
check('only certain by default', () => {
  const jobs = [job({ id: 'a', lead_id: 'lead-1' }), job({ id: 'b', lead_id: null })];
  const m = recoverClicks(jobs, pool({ leads: [lead()] }));
  assert.deepEqual([...m.keys()], ['a']);
});
check('likely behind the flag', () => {
  const jobs = [job({ id: 'a', lead_id: 'lead-1' }), job({ id: 'b', lead_id: null })];
  const m = recoverClicks(jobs, pool({ leads: [lead()] }), { includeLikely: true });
  assert.deepEqual([...m.keys()].sort(), ['a', 'b']);
});
check('unfinished jobs are skipped', () =>
  assert.equal(recoverClicks([job({ status: 'gepland', lead_id: 'lead-1' })], pool({ leads: [lead()] })).size, 0));

/* the feed */
const feedJob = (over: Partial<FeedJobRow> = {}): FeedJobRow => ({
  id: 'job-1',
  status: 'afgerond',
  gross_margin: 100,
  completed_at: '2026-11-05T10:00:00Z',
  gclid: null,
  wbraid: null,
  gbraid: null,
  click_captured_at: null,
  leads: null,
  customer_phone: '0612345678',
  ...over,
});
const NOW = new Date('2026-11-11T12:00:00Z');
check('feed: recovered job becomes a row in the right column', () => {
  const m = recoverClicks([job({ lead_id: 'lead-1' })], pool({ leads: [lead({ gclid: null, wbraid: WB })] }));
  const r = buildAdsFeed([feedJob({ lead_id: 'lead-1' })], NOW, m);
  assert.equal(r.counts.rows, 1);
  assert.equal(r.counts.recovered_certain, 1);
  assert.match(r.csv, new RegExp(`\\n,,${WB},Job Completed,2026-11-05 11:00:00,100.00,EUR\\n`));
});
check('feed: without recoveries nothing changes', () => {
  const r = buildAdsFeed([feedJob()], NOW);
  assert.equal(r.counts.rows, 0);
  assert.equal(r.counts.skipped_no_click_id, 1);
});
check('feed: own click id beats a recovery', () => {
  const m = new Map([['job-1', { kind: 'gclid' as const, id: G2, rule: 'claimed_click' as const, confidence: 'certain' as const, clickedAt: '2026-11-02T08:00:00Z' }]]);
  const r = buildAdsFeed([feedJob({ gclid: G1 })], NOW, m);
  assert.ok(r.csv.includes(G1));
  assert.ok(!r.csv.includes(G2));
  assert.equal(r.counts.recovered_certain, 0);
});
check('feed: recovered click after the completion is dropped as bad time', () => {
  const m = new Map([['job-1', { kind: 'gclid' as const, id: G2, rule: 'claimed_click' as const, confidence: 'certain' as const, clickedAt: '2026-11-06T08:00:00Z' }]]);
  assert.equal(buildAdsFeed([feedJob()], NOW, m).counts.skipped_bad_time, 1);
});
check('feed: likely recovery is counted as likely', () => {
  const m = recoverClicks([job()], pool({ leads: [lead()] }), { includeLikely: true });
  assert.equal(buildAdsFeed([feedJob()], NOW, m).counts.recovered_likely, 1);
});

/* privacy */
check('recovery carries no phone digits', () => {
  const c = recovered(job(), pool({ leads: [lead()] }));
  assert.ok(!/612345678|0612345678|31612345678/.test(JSON.stringify(c)));
  assert.deepEqual(Object.keys(c).sort(), ['clickedAt', 'confidence', 'id', 'kind', 'rule']);
});
check('ambiguous answer carries only status and rule', () => {
  const r = resolveJobClick(job(), pool({ leads: [lead(), lead({ id: 'lead-2', gclid: G2 })] }));
  assert.deepEqual(Object.keys(r).sort(), ['rule', 'status']);
});
check('feed csv has no phone, name or email', () => {
  const m = recoverClicks([job()], pool({ leads: [lead()] }), { includeLikely: true });
  const r = buildAdsFeed([feedJob({ customer_name: 'Jan Jansen', customer_email: 'jan@example.test' })], NOW, m);
  assert.ok(!/612345678|Jansen|@/.test(r.csv));
});
check('stats output holds counts and week labels only', () => {
  const s = attributionStats([job({ lead_id: 'lead-1' })], pool({ leads: [lead()] }));
  assert.ok(!/612345678|Cj0KCQ/.test(JSON.stringify(s)));
});

/* stats and weeks */
check('week starts on Monday, Amsterdam time', () => {
  assert.equal(weekStartAmsterdam('2026-11-05T10:00:00Z'), '2026-11-02');
  assert.equal(weekStartAmsterdam('2026-11-08T23:30:00Z'), '2026-11-09');
  assert.equal(weekStartAmsterdam('nonsense'), null);
});
check('stats split jobs by outcome', () => {
  const jobs = [
    job({ id: 'direct', gclid: G2 }),
    job({ id: 'viaLead', lead_id: 'lead-1', customer_phone: null }),
    job({ id: 'viaClaim', customer_phone: null }),
    job({ id: 'viaPhone', customer_phone: '0699999999' }),
    job({ id: 'none', customer_phone: '0600000000' }),
    job({ id: 'open', status: 'gepland' }),
  ];
  const p = pool({
    leads: [lead({ id: 'lead-1', phone: null, phone_e164: null }), lead({ id: 'lead-9', phone: '0699999999', phone_e164: null, gclid: G2 })],
    clicks: [click({ claimed_by_job_id: 'viaClaim' })],
  });
  const s = attributionStats(jobs, p);
  assert.equal(s.total.finished, 5);
  assert.equal(s.total.direct, 1);
  assert.equal(s.total.recovered.lead_link, 1);
  assert.equal(s.total.recovered.claimed_click, 1);
  assert.equal(s.total.recovered.phone_lead, 1);
  assert.equal(s.total.recovered.chat_ref, 0);
  assert.equal(s.total.without, 1);
  assert.equal(s.weeks.length, 1);
  assert.equal(s.weeks[0].week, '2026-11-02');
});
check('stats count ambiguous separately', () => {
  const s = attributionStats([job()], pool({ leads: [lead(), lead({ id: 'lead-2', gclid: G2 })] }));
  assert.equal(s.total.ambiguous, 1);
  assert.equal(s.total.without, 0);
});

console.log(`attribution: ${n} checks passed`);
