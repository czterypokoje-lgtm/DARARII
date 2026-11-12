/**
 * Finds the Google click id for a finished job that has none of its own.
 *
 * Pure on purpose: rows in, answers out, no clock, no network. The answers
 * carry a click id, the rule that found it, a confidence and the time of the
 * click. They never carry a phone number, a name or anything else about a
 * person: phone numbers are read to compare and then dropped.
 *
 * Rules, strongest first. "certain" means a person or an exact code tied the
 * click to this job or this chat; "likely" means only the phone number does.
 *
 *   lead_link      certain  the job's own lead holds a click id
 *   claimed_click  certain  a call_clicks row was claimed by this job
 *   chat_ref       certain  a WhatsApp ad code ([K7F2]) from a chat with the
 *                           same phone number points to one click
 *   phone_lead     likely   another lead with the same phone number holds one
 *
 * Never a guess: when two different click ids qualify at the same level the
 * job gets nothing ("ambiguous"). A wrong id sent to Google teaches Smart
 * Bidding to buy the wrong traffic, a missing one only costs a data point.
 *
 * Window: a click counts only when it is not later than the job's completion
 * and not older than 90 days before it (Google's own click window).
 */

export type ClickKind = 'gclid' | 'gbraid' | 'wbraid';
export type Rule = 'lead_link' | 'claimed_click' | 'chat_ref' | 'phone_lead';
export type Confidence = 'certain' | 'likely';

export const RULE_CONFIDENCE: Readonly<Record<Rule, Confidence>> = {
  lead_link: 'certain',
  claimed_click: 'certain',
  chat_ref: 'certain',
  phone_lead: 'likely',
};
export const RULES: readonly Rule[] = ['lead_link', 'claimed_click', 'chat_ref', 'phone_lead'];
export const ATTRIBUTION_WINDOW_DAYS = 90;

type Id = string | null | undefined;

export interface AttrJob {
  id: string;
  status?: Id;
  completed_at?: Id;
  lead_id?: Id;
  customer_phone?: Id;
  gclid?: Id;
  wbraid?: Id;
  gbraid?: Id;
  [extra: string]: unknown;
}
export interface AttrLead {
  id: string;
  phone?: Id;
  phone_e164?: Id;
  created_at?: Id;
  gclid?: Id;
  wbraid?: Id;
  gbraid?: Id;
  [extra: string]: unknown;
}
export interface AttrClick {
  id: string;
  ref?: Id;
  created_at?: Id;
  claimed_by_job_id?: Id;
  gclid?: Id;
  wbraid?: Id;
  gbraid?: Id;
  [extra: string]: unknown;
}
/** A WhatsApp chat that started with an ad code. Comes from the chat side, not from the CRM tables. */
export interface AttrChatRef {
  ref: string;
  phone: string;
  [extra: string]: unknown;
}

export interface AttrPool {
  leads: readonly AttrLead[];
  clicks: readonly AttrClick[];
  chats?: readonly AttrChatRef[];
}

export interface JobClick {
  kind: ClickKind;
  id: string;
  rule: Rule;
  confidence: Confidence;
  /** ISO time of the click (or of the lead that carried it). */
  clickedAt: string;
}

export type JobOutcome =
  | { status: 'direct'; kind: ClickKind }
  | { status: 'recovered'; click: JobClick }
  | { status: 'ambiguous'; rule: Rule }
  | { status: 'none' };

const DAY_MS = 24 * 60 * 60 * 1000;
const CLICK_ID = /^[A-Za-z0-9_-]{8,200}$/;
const KINDS: readonly ClickKind[] = ['gclid', 'gbraid', 'wbraid'];

const clean = (v: Id): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return CLICK_ID.test(t) ? t : null;
};

const toMs = (v: Id): number | null => {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Last 9 digits of any phone spelling, or null when there are fewer than 9.
 * "06 12345678", "+31 6 1234 5678", "0031612345678" and "31612345678" all give
 * the same key. Only digits count, so "(+31)-6-12345678" works too.
 */
export function phoneKey(v: Id): string | null {
  const digits = (typeof v === 'string' ? v : '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** The click id on a row, gclid before gbraid before wbraid (the feed's own order). */
export function clickOf(row: { gclid?: Id; wbraid?: Id; gbraid?: Id } | null | undefined): { kind: ClickKind; id: string } | null {
  if (!row) return null;
  for (const kind of KINDS) {
    const id = clean(row[kind]);
    if (id) return { kind, id };
  }
  return null;
}

interface Candidate {
  kind: ClickKind;
  id: string;
  rule: Rule;
  at: number;
}

/**
 * Settles one job. `direct` jobs are left alone by every caller: the job's
 * own columns win, exactly as in the feed.
 */
export function resolveJobClick(job: AttrJob, pool: AttrPool): JobOutcome {
  const own = clickOf(job);
  if (own) return { status: 'direct', kind: own.kind };

  const doneMs = toMs(job.completed_at);
  if (doneMs === null || doneMs <= 0) return { status: 'none' };
  const earliest = doneMs - ATTRIBUTION_WINDOW_DAYS * DAY_MS;
  const inWindow = (at: number | null): at is number => at !== null && at >= earliest && at <= doneMs;

  const cands: Candidate[] = [];
  const add = (rule: Rule, row: { gclid?: Id; wbraid?: Id; gbraid?: Id }, atRaw: Id) => {
    const c = clickOf(row);
    const at = toMs(atRaw);
    if (c && inWindow(at)) cands.push({ ...c, rule, at });
  };

  /* 1. its own lead */
  if (job.lead_id) {
    const lead = pool.leads.find((l) => l.id === job.lead_id);
    if (lead) add('lead_link', lead, lead.created_at);
  }

  /* 2. a call_clicks row this job claimed */
  for (const click of pool.clicks) {
    if (click.claimed_by_job_id === job.id) add('claimed_click', click, click.created_at);
  }

  const jobKey = phoneKey(job.customer_phone);
  if (jobKey) {
    /* 3. a chat with the same number whose ad code points to a click that no other job took */
    const refs = new Set<string>();
    for (const chat of pool.chats ?? []) {
      if (phoneKey(chat.phone) === jobKey && typeof chat.ref === 'string') refs.add(chat.ref.trim().toUpperCase());
    }
    if (refs.size) {
      for (const click of pool.clicks) {
        const ref = typeof click.ref === 'string' ? click.ref.trim().toUpperCase() : '';
        if (!ref || !refs.has(ref)) continue;
        if (click.claimed_by_job_id && click.claimed_by_job_id !== job.id) continue;
        add('chat_ref', click, click.created_at);
      }
    }

    /* 4. another lead with the same number */
    for (const lead of pool.leads) {
      if (lead.id === job.lead_id) continue;
      if (phoneKey(lead.phone) === jobKey || phoneKey(lead.phone_e164) === jobKey) {
        add('phone_lead', lead, lead.created_at);
      }
    }
  }

  /* Certain rules first; only when they found nothing do the likely ones count. */
  for (const level of ['certain', 'likely'] as const) {
    const atLevel = cands.filter((c) => RULE_CONFIDENCE[c.rule] === level);
    if (!atLevel.length) continue;
    const distinct = new Set(atLevel.map((c) => c.id));
    if (distinct.size > 1) return { status: 'ambiguous', rule: atLevel[0].rule };
    /* Same id from several rules: report the strongest, earliest click time. */
    const best = [...atLevel].sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule) || a.at - b.at)[0];
    return {
      status: 'recovered',
      click: {
        kind: best.kind,
        id: best.id,
        rule: best.rule,
        confidence: level,
        clickedAt: new Date(best.at).toISOString(),
      },
    };
  }
  return { status: 'none' };
}

/**
 * Recoveries for every finished job that has no click id of its own.
 * Keyed by job id; jobs that are direct, ambiguous or without any match are absent.
 */
export function recoverClicks(
  jobs: readonly AttrJob[],
  pool: AttrPool,
  options: { includeLikely?: boolean } = {}
): Map<string, JobClick> {
  const out = new Map<string, JobClick>();
  for (const job of jobs) {
    if (job.status !== 'afgerond') continue;
    const r = resolveJobClick(job, pool);
    if (r.status !== 'recovered') continue;
    if (r.click.confidence === 'likely' && !options.includeLikely) continue;
    out.set(job.id, r.click);
  }
  return out;
}

/** Monday of the week of an instant, as YYYY-MM-DD in Europe/Amsterdam. */
export function weekStartAmsterdam(iso: Id): string | null {
  const ms = toMs(iso);
  if (ms === null) return null;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(ms));
  const d = new Date(`${ymd}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

export interface WeekCounts {
  week: string;
  finished: number;
  direct: number;
  recovered: Record<Rule, number>;
  ambiguous: number;
  without: number;
}

const emptyWeek = (week: string): WeekCounts => ({
  week,
  finished: 0,
  direct: 0,
  recovered: { lead_link: 0, claimed_click: 0, chat_ref: 0, phone_lead: 0 },
  ambiguous: 0,
  without: 0,
});

/** Counts only: per week of completion, how each finished job got (or did not get) a click id. */
export function attributionStats(jobs: readonly AttrJob[], pool: AttrPool): { weeks: WeekCounts[]; total: WeekCounts } {
  const byWeek = new Map<string, WeekCounts>();
  const total = emptyWeek('total');
  for (const job of jobs) {
    if (job.status !== 'afgerond') continue;
    const week = weekStartAmsterdam(job.completed_at) ?? 'onbekend';
    const w = byWeek.get(week) ?? emptyWeek(week);
    byWeek.set(week, w);
    const r = resolveJobClick(job, pool);
    for (const t of [w, total]) {
      t.finished++;
      if (r.status === 'direct') t.direct++;
      else if (r.status === 'recovered') t.recovered[r.click.rule]++;
      else if (r.status === 'ambiguous') t.ambiguous++;
      else t.without++;
    }
  }
  return { weeks: [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1)), total };
}
