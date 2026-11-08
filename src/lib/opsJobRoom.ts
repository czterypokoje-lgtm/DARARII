import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkOps, logOps } from './opsAuth.ts';
import { toE164NL } from './phone.ts';

/**
 * The job room, as the server transport sees it (slice S1, SHADOW).
 *
 * Everything here records. Nothing sends: there is no claim or report step, and
 * the database refuses a shadow outbox row that is claimed or sent. Going live
 * is a later, separate decision.
 *
 * Handlers take the client and the parsed body and return a status and a body,
 * so the route files stay thin and the logic is testable without Next.
 */

export type Result = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>, status = 200): Result => ({ status, body });
const bad = (error: string, status = 400, extra: Record<string, unknown> = {}): Result => ({
  status,
  body: { error, ...extra },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A trimmed string within a length, or null. Control characters are stripped. */
export function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text && text.length <= max ? text : null;
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Accent folding for names: ğ→g, ı→i, ö→o. Exact match only, never fuzzy. */
export function foldName(name: string): string {
  return name
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/gi, 'g')
    .replace(/ş/gi, 's')
    .replace(/ç/gi, 'c')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The same message for the same job, person and kind is one row. */
export const dedupeKey = (jobRoomId: string, contactId: string, kind: string, textHash: string) =>
  sha256([jobRoomId, contactId, kind, textHash].join('\u001f'));

export type Audience = 'customer_reply' | 'technician' | 'self_started' | 'internal';
const AUDIENCES = ['customer_reply', 'technician', 'self_started', 'internal'] as const;

const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;
/** Nine digits or more in one run: a phone number, not a date (8 digits) or a price. */
const hasPhone = (text: string) =>
  (text.match(PHONE_CANDIDATE) ?? []).some((m) => m.replace(/\D/g, '').length >= 9);
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PLATE = /\b(?:[A-Z0-9]{2}-[A-Z0-9]{2}-[A-Z0-9]{2}|[A-Z]{1,3}-\d{2,3}-[A-Z]{1,2}|\d-[A-Z]{3}-\d{2})\b/i;
const SECRET = /sk-ant-|sb_secret_|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\./;

/**
 * Never-rules, at the moment a row is proposed. A message to a customer or a
 * technician may hold no phone number, email address or licence plate, and no
 * key-like string anywhere. Internal messages (owner, assistant) may; a key
 * string is refused everywhere. Returns the reason, or null when clean.
 */
export function guardText(text: string, audience: Audience): string | null {
  if (SECRET.test(text)) return 'secret';
  if (audience === 'internal') return null;
  if (hasPhone(text)) return 'phone';
  if (EMAIL.test(text)) return 'email';
  if (PLATE.test(text)) return 'plate';
  return null;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const ROLES = ['customer', 'technician', 'garage', 'staff', 'owner'] as const;
const COUNTRIES = ['NL', 'DE'] as const;
const LANGS = ['nl', 'de', 'en', 'tr'] as const;

type ContactInput = {
  phone: string;
  name: string;
  role: (typeof ROLES)[number];
  country: (typeof COUNTRIES)[number];
  language: (typeof LANGS)[number];
  waName: string | null;
  city: string | null;
};

function parseContact(b: Record<string, unknown>): ContactInput | string {
  const phone = toE164NL(typeof b.phone === 'string' ? b.phone : null);
  if (!phone || !/^\+[1-9][0-9]{7,14}$/.test(phone)) return 'Ongeldig telefoonnummer';
  const name = clean(b.name, 120);
  if (!name) return 'Naam ontbreekt';
  return {
    phone,
    name,
    role: oneOf(b.role, ROLES) ?? 'customer',
    country: oneOf(b.country, COUNTRIES) ?? 'NL',
    language: oneOf(b.language, LANGS) ?? 'nl',
    waName: clean(b.waName, 120),
    city: clean(b.city, 80),
  };
}

type Row = Record<string, unknown>;

/** Finds the contact by number or creates it. The number is the key; a later name never overwrites. */
async function upsertContact(
  supabase: SupabaseClient,
  c: ContactInput
): Promise<{ id: string; created: boolean; role: string } | { error: string }> {
  const now = new Date().toISOString();
  const found = await supabase.from('contacts').select('id, role').eq('phone_e164', c.phone).maybeSingle();
  if (found.error) return { error: found.error.message };
  if (found.data) {
    await supabase.from('contacts').update({ last_contact_at: now }).eq('id', found.data.id);
    return { id: found.data.id as string, created: false, role: found.data.role as string };
  }
  const ins = await supabase
    .from('contacts')
    .insert({
      phone_e164: c.phone,
      display_name: c.name,
      wa_name: c.waName,
      role: c.role,
      country: c.country,
      language: c.language,
      city: c.city,
      first_contact_at: now,
      last_contact_at: now,
    })
    .select('id')
    .single();
  if (ins.error?.code === '23505') {
    const again = await supabase.from('contacts').select('id, role').eq('phone_e164', c.phone).maybeSingle();
    if (again.data) return { id: again.data.id as string, created: false, role: again.data.role as string };
  }
  if (ins.error || !ins.data) return { error: ins.error?.message ?? 'insert failed' };
  return { id: ins.data.id as string, created: true, role: c.role };
}

/** POST: save a contact (every customer who writes) and optionally one explicit alias. */
export async function saveContact(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  const parsed = parseContact(raw);
  if (typeof parsed === 'string') return bad(parsed);
  const saved = await upsertContact(supabase, parsed);
  if ('error' in saved) return bad('Opslaan mislukt', 500);

  // A technician, garage or staff member is always findable by the full name
  // they were saved under. This is identity, not a guess, so it needs no pick.
  if (saved.created && parsed.role !== 'customer') {
    await supabase.from('contact_aliases').insert({
      contact_id: saved.id,
      alias: parsed.name,
      alias_folded: foldName(parsed.name),
      source: 'system',
    });
  }

  const alias = clean(raw.alias, 120);
  if (alias) {
    // Aliases come only from an explicit pick, so the pick must say who confirmed it.
    const confirmedBy = clean(raw.confirmedBy, 80);
    if (!confirmedBy) return bad('Alias vraagt een bevestiging', 400, { contactId: saved.id });
    const ins = await supabase.from('contact_aliases').insert({
      contact_id: saved.id,
      alias,
      alias_folded: foldName(alias),
      source: 'owner_pick',
      confirmed_by: confirmedBy,
    });
    if (ins.error && ins.error.code !== '23505') return bad('Alias opslaan mislukt', 500);
  }
  return ok({ contactId: saved.id, created: saved.created }, saved.created ? 201 : 200);
}

/**
 * GET: exact alias match after folding. One hit resolves; none or several
 * return the candidates so the caller asks. Fuzzy matches are never returned.
 */
export async function resolveContact(
  supabase: SupabaseClient,
  q: string | null,
  opts: { role?: string | null; last4?: string | null } = {}
): Promise<Result> {
  const name = clean(q, 120);
  if (!name) return bad('Naam ontbreekt');
  const folded = foldName(name);

  const aliases = await supabase
    .from('contact_aliases')
    .select('contact_id')
    .eq('alias_folded', folded)
    .is('revoked_at', null);
  if (aliases.error) return bad('Zoeken mislukt', 500);

  const ids = [...new Set((aliases.data ?? []).map((a) => a.contact_id as string))];
  if (ids.length === 0) return ok({ status: 'none', candidates: [] });

  const role = opts.role ? oneOf(opts.role, ROLES) : null;
  if (opts.role && !role) return bad('Ongeldige rol');
  const last4 = opts.last4 && /^\d{4}$/.test(opts.last4) ? opts.last4 : null;
  if (opts.last4 && !last4) return bad('Ongeldige laatste 4 cijfers');

  let lookup = supabase
    .from('contacts')
    .select('id, display_name, role, city, phone_e164')
    .in('id', ids)
    .eq('active', true);
  // Technicians resolve only from the technician book.
  if (role) lookup = lookup.eq('role', role);
  const contacts = await lookup;
  if (contacts.error) return bad('Zoeken mislukt', 500);
  if (last4) contacts.data = (contacts.data ?? []).filter((c: Row) => String(c.phone_e164).endsWith(last4));

  // Only the last 4 digits leave this function, enough to tell two people apart.
  const candidates = (contacts.data ?? []).map((c: Row) => ({
    id: c.id,
    name: c.display_name,
    role: c.role,
    city: c.city,
    last4: String(c.phone_e164).slice(-4),
  }));
  if (candidates.length === 1) return ok({ status: 'one', contact: candidates[0], candidates });
  return ok({ status: candidates.length === 0 ? 'none' : 'ambiguous', candidates });
}

// ---------------------------------------------------------------------------
// Job rooms
// ---------------------------------------------------------------------------

/** POST: create the job room for a lead or job; the same lead or job returns the same room. */
export async function openJobRoom(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  const leadId = raw.leadId === undefined ? null : raw.leadId;
  const jobId = raw.jobId === undefined ? null : raw.jobId;
  if (leadId !== null && !isUuid(leadId)) return bad('Ongeldige lead');
  if (jobId !== null && !isUuid(jobId)) return bad('Ongeldige klus');

  const keyCol = leadId ? 'lead_id' : jobId ? 'job_id' : null;
  const keyVal = (leadId ?? jobId) as string | null;
  if (keyCol && keyVal) {
    const existing = await supabase.from('job_rooms').select('id, code').eq(keyCol, keyVal).maybeSingle();
    if (existing.error) return bad('Opslaan mislukt', 500);
    if (existing.data) return ok(roomBody(existing.data, false));
  }

  let customerContactId: string | null = null;
  if (raw.customer !== undefined) {
    const parsed = isObject(raw.customer) ? parseContact(raw.customer) : 'Ongeldige klant';
    if (typeof parsed === 'string') return bad(parsed);
    const saved = await upsertContact(supabase, { ...parsed, role: 'customer' });
    if ('error' in saved) return bad('Opslaan mislukt', 500);
    customerContactId = saved.id;
  }

  const postcode = clean(raw.postcode, 12);
  const row = {
    lead_id: leadId,
    job_id: jobId,
    customer_contact_id: customerContactId,
    country: oneOf(raw.country, COUNTRIES) ?? 'NL',
    language: oneOf(raw.language, ['nl', 'de', 'en'] as const) ?? 'nl',
    service_type: clean(raw.serviceType, 80),
    city: clean(raw.city, 80),
    postcode4: postcode && /^\d{4}/.test(postcode) ? postcode.slice(0, 4) : null,
    car_label: clean(raw.carLabel, 80),
    plate: clean(raw.plate, 12),
  };
  const ins = await supabase.from('job_rooms').insert(row).select('id, code').single();
  if (ins.error?.code === '23505' && keyCol && keyVal) {
    const again = await supabase.from('job_rooms').select('id, code').eq(keyCol, keyVal).maybeSingle();
    if (again.data) return ok(roomBody(again.data, false));
  }
  if (ins.error || !ins.data) return bad('Opslaan mislukt', 500);

  if (customerContactId) {
    await supabase
      .from('job_parties')
      .insert({ job_room_id: ins.data.id, contact_id: customerContactId, role: 'customer' });
  }
  return ok(roomBody(ins.data, true), 201);
}

const roomBody = (r: Row, created: boolean) => ({
  jobRoomId: r.id,
  code: `J-${r.code}`,
  created,
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const CHANNELS = ['whatsapp', 'telegram', 'crm', 'voice', 'system'] as const;
const DIRECTIONS = ['in', 'out', 'internal'] as const;

/** POST: one row per message in or out. A replay (same provider message id) is a harmless no-op. */
export async function recordEvent(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  const direction = oneOf(raw.direction, DIRECTIONS);
  const channel = oneOf(raw.channel, CHANNELS);
  const actor = clean(raw.actor, 80);
  const kind = clean(raw.kind, 80);
  if (!direction || !channel || !actor || !kind) return bad('Ongeldige gebeurtenis');
  if (raw.jobRoomId !== undefined && raw.jobRoomId !== null && !isUuid(raw.jobRoomId)) {
    return bad('Ongeldige klus');
  }
  if (raw.contactId !== undefined && raw.contactId !== null && !isUuid(raw.contactId)) {
    return bad('Ongeldig contact');
  }

  const body = typeof raw.body === 'string' ? raw.body.slice(0, 8000) : null;
  const row = {
    job_room_id: (raw.jobRoomId as string | null | undefined) ?? null,
    contact_id: (raw.contactId as string | null | undefined) ?? null,
    direction,
    channel,
    actor,
    kind,
    provider_message_id: clean(raw.providerMessageId, 200),
    event_key: clean(raw.eventKey, 200),
    body,
    meta: isObject(raw.meta) ? raw.meta : {},
    status: oneOf(raw.status, ['recorded', 'processed', 'blocked', 'error'] as const) ?? 'recorded',
  };
  const ins = await supabase.from('job_events').insert(row).select('id').single();
  if (ins.error?.code === '23505') return ok({ duplicate: true });
  if (ins.error || !ins.data) return bad('Opslaan mislukt', 500);
  return ok({ eventId: ins.data.id, duplicate: false }, 201);
}

// ---------------------------------------------------------------------------
// Outbox (shadow) and approvals
// ---------------------------------------------------------------------------

/**
 * POST: propose one message. Shadow only: the row is stored as `proposed` with
 * shadow = true and never moves past `approved`. A text that breaks a
 * never-rule is not stored as outbox; it is logged as a blocked event instead.
 */
export async function proposeOutbox(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  if (!isUuid(raw.jobRoomId)) return bad('Ongeldige klus');
  if (!isUuid(raw.contactId)) return bad('Ongeldig contact');
  const audience = oneOf(raw.audience, AUDIENCES);
  const kind = clean(raw.kind, 80);
  const body = clean(raw.body, 4000);
  const tier = typeof raw.tier === 'number' && [0, 1, 2].includes(raw.tier) ? raw.tier : null;
  if (!audience || !kind || !body || tier === null) return bad('Ongeldig bericht');

  const refused = guardText(body, audience);
  if (refused) {
    await supabase.from('job_events').insert({
      job_room_id: raw.jobRoomId,
      contact_id: raw.contactId,
      direction: 'internal',
      channel: 'system',
      actor: 'jobroom-guard',
      kind: 'outbox.blocked',
      status: 'blocked',
      meta: { reason: refused, audience, kind },
    });
    return bad('Bericht geblokkeerd', 422, { reason: refused });
  }

  // Metadata only (what is attached, and a hash of it). Needs migration 0079,
  // so the column is written only when a caller sends one.
  const attachment = isObject(raw.attachment) && JSON.stringify(raw.attachment).length <= 2000 ? raw.attachment : null;

  const textHash = sha256(body);
  const key = dedupeKey(raw.jobRoomId, raw.contactId, kind, textHash);
  const ins = await supabase
    .from('job_outbox')
    .insert({
      job_room_id: raw.jobRoomId,
      contact_id: raw.contactId,
      audience,
      kind,
      tier,
      body,
      text_hash: textHash,
      dedupe_key: key,
      state: 'proposed',
      shadow: true,
      ...(attachment ? { attachment } : {}),
    })
    .select('id, state')
    .single();
  if (ins.error?.code === '23505') {
    const existing = await supabase.from('job_outbox').select('id, state').eq('dedupe_key', key).maybeSingle();
    if (existing.data) return ok({ outboxId: existing.data.id, state: existing.data.state, duplicate: true });
  }
  if (ins.error || !ins.data) return bad('Opslaan mislukt', 500);
  return ok({ outboxId: ins.data.id, state: ins.data.state, duplicate: false, shadow: true }, 201);
}

/** GET: the queue, newest first, so the transport (and the owner) can see what is waiting. */
export async function listOutbox(
  supabase: SupabaseClient,
  state: string | null,
  limit: number
): Promise<Result> {
  const wanted = state ? oneOf(state, ['proposed', 'approved', 'sent', 'unknown', 'failed', 'cancelled'] as const) : null;
  if (state && !wanted) return bad('Ongeldige status');
  let query = supabase
    .from('job_outbox')
    .select('id, job_room_id, contact_id, audience, kind, tier, state, shadow, text_hash, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (wanted) query = query.eq('state', wanted);
  const { data, error } = await query;
  if (error) return bad('Ophalen mislukt', 500);
  return ok({ items: data ?? [] });
}

/**
 * POST: a person releases (or refuses) one exact text. The hash they saw must
 * equal the stored one, so an edit after the read-back card cancels the release.
 * In shadow this only moves proposed → approved; nothing is sent.
 */
export async function decideApproval(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  if (!isUuid(raw.outboxId)) return bad('Ongeldig bericht');
  const decision = oneOf(raw.decision, ['approved', 'rejected'] as const);
  const decidedBy = clean(raw.decidedBy, 80);
  const via = oneOf(raw.via, ['owner_tap', 'owner_voice', 'assistant', 'system'] as const);
  const seenHash = typeof raw.textHash === 'string' ? raw.textHash : '';
  if (!decision || !decidedBy || !via || !/^[0-9a-f]{64}$/.test(seenHash)) return bad('Ongeldige beslissing');

  const found = await supabase
    .from('job_outbox')
    .select('id, job_room_id, state, text_hash')
    .eq('id', raw.outboxId)
    .maybeSingle();
  if (found.error) return bad('Ophalen mislukt', 500);
  if (!found.data) return bad('Bericht niet gevonden', 404);
  if (found.data.state !== 'proposed') return bad('Bericht is al behandeld', 409, { state: found.data.state });
  if (found.data.text_hash !== seenHash) return bad('Tekst is gewijzigd', 409);

  const ins = await supabase
    .from('job_approvals')
    .insert({
      outbox_id: found.data.id,
      job_room_id: found.data.job_room_id,
      decision,
      text_hash: seenHash,
      decided_by: decidedBy,
      decided_via: via,
    })
    .select('id, code')
    .single();
  if (ins.error?.code === '23505') return bad('Bericht is al behandeld', 409);
  if (ins.error || !ins.data) return bad('Opslaan mislukt', 500);

  const next =
    decision === 'approved'
      ? { state: 'approved', approved_by: decidedBy, approved_at: new Date().toISOString() }
      : { state: 'cancelled' };
  const upd = await supabase
    .from('job_outbox')
    .update(next)
    .eq('id', found.data.id)
    .eq('state', 'proposed')
    .select('id');
  if (upd.error || !upd.data?.length) return bad('Bijwerken mislukt', 409);

  return ok({ approvalCode: `A${ins.data.code}`, state: next.state, shadow: true }, 201);
}

// ---------------------------------------------------------------------------
// Route wrapper: the checkOps / logOps pattern every /api/ops route uses
// ---------------------------------------------------------------------------

/**
 * Auth first (fails closed), then the body or the query, then the handler, then
 * one audit row. The client is created after auth so an unauthenticated call
 * never touches the database or its keys. `input` is the parsed JSON body for a
 * POST and the URL for a GET.
 */
export async function runOps(
  request: Request,
  getClient: () => SupabaseClient,
  action: string,
  handler: (supabase: SupabaseClient, input: unknown) => Promise<Result>
): Promise<Response> {
  const json = (r: Result) =>
    new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });

  const auth = checkOps(request);
  if (!auth.ok) return json(bad(auth.error, auth.status));

  let input: unknown;
  if (request.method === 'GET') {
    input = new URL(request.url);
  } else {
    input = await request.json().catch(() => null);
    if (input === null) return json(bad('Ongeldige invoer'));
  }

  const supabase = getClient();
  const result = await handler(supabase, input);
  // The action and the outcome, never the message text or the number.
  await logOps(supabase, action, { status: result.status });
  return json(result);
}

// ---------------------------------------------------------------------------
// S3: several names in one note, and every customer who writes
// ---------------------------------------------------------------------------

const NAME_SPLIT = /\s*(?:,|;|\/|&|\+|\n|\band\b|\ben\b|\bve\b|\bund\b)\s*/i;

/**
 * "Ali, Mehmet en Oğuz" → one lookup per name. Every name must resolve to
 * exactly one contact; otherwise `status` is 'ask' and `ask` lists what to put
 * to the owner (numbered choices with name, city and last 4 digits). Nothing
 * here guesses: a name with no exact alias is `none`, never the nearest match.
 */
export async function resolveNote(
  supabase: SupabaseClient,
  text: string | null,
  opts: { role?: string | null } = {}
): Promise<Result> {
  const note = clean(text, 400);
  if (!note) return bad('Naam ontbreekt');
  const names = [...new Set(note.split(NAME_SPLIT).map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0 || names.length > 10) return bad('Ongeldig aantal namen');

  const results: Row[] = [];
  for (const name of names) {
    const r = await resolveContact(supabase, name, opts);
    if (r.status !== 200) return r;
    results.push({ input: name, status: r.body.status, contact: r.body.contact ?? null, candidates: r.body.candidates });
  }

  // Two different names that land on the same person are one recipient.
  const picked = new Set<string>();
  for (const r of results) {
    const id = (r.contact as Row | null)?.id as string | undefined;
    if (id && picked.has(id)) r.status = 'duplicate';
    if (id) picked.add(id);
  }
  const ask = results.filter((r) => r.status === 'none' || r.status === 'ambiguous');
  return ok({
    status: ask.length === 0 ? 'all' : 'ask',
    recipients: [...picked],
    results,
    ask: ask.map((r) => ({ input: r.input, status: r.status, candidates: r.candidates })),
  });
}

/**
 * POST: a message arrived from a number. The sender is saved as a contact at
 * once (a number already known keeps its role: a technician is never turned
 * into a customer), and the raw message is logged before anything reads it.
 */
export async function recordInbound(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  const phone = toE164NL(typeof raw.phone === 'string' ? raw.phone : null);
  if (!phone || !/^\+[1-9][0-9]{7,14}$/.test(phone)) return bad('Ongeldig telefoonnummer');
  const providerMessageId = clean(raw.providerMessageId, 200);
  if (!providerMessageId) return bad('Bericht-id ontbreekt');
  const channel = oneOf(raw.channel, CHANNELS) ?? 'whatsapp';
  const waName = clean(raw.waName, 120);
  if (raw.jobRoomId !== undefined && raw.jobRoomId !== null && !isUuid(raw.jobRoomId)) return bad('Ongeldige klus');

  const german = phone.startsWith('+49');
  const saved = await upsertContact(supabase, {
    phone,
    name: waName ?? `Klant ${phone.slice(-4)}`,
    role: 'customer',
    country: german ? 'DE' : 'NL',
    language: german ? 'de' : 'nl',
    waName,
    city: null,
  });
  if ('error' in saved) return bad('Opslaan mislukt', 500);

  const ev = await recordEvent(supabase, {
    direction: 'in',
    channel,
    actor: 'transport',
    kind: 'message',
    providerMessageId,
    contactId: saved.id,
    jobRoomId: raw.jobRoomId ?? null,
    body: typeof raw.body === 'string' ? raw.body : null,
  });
  if (ev.status >= 500) return ev;
  return ok(
    { contactId: saved.id, created: saved.created, role: saved.role, duplicate: ev.body.duplicate === true },
    saved.created ? 201 : 200
  );
}

// ---------------------------------------------------------------------------
// S6: invoice send, CRM side (shadow)
// ---------------------------------------------------------------------------

const INVOICE_NUMBER = /^I-\d{5}$/;
const euro = (n: number) => n.toFixed(2).replace('.', ',');

type Snapshot = { invoiceNumber: string; status: string; total: number; jobId: string | null; hash: string };

/** The invoice as it stands now: number, total and lines, hashed. Any later edit changes the hash. */
async function invoiceSnapshot(supabase: SupabaseClient, invoiceNumber: string): Promise<Snapshot | Result> {
  const inv = await supabase
    .from('sales_invoices')
    .select('id, invoice_number, status, total, subtotal, vat_total, credit_applied, job_id')
    .eq('invoice_number', invoiceNumber)
    .maybeSingle();
  if (inv.error) return bad('Ophalen mislukt', 500);
  if (!inv.data) return bad('Factuur niet gevonden', 404);

  const lines = await supabase
    .from('sales_invoice_lines')
    .select('line_no, description, quantity, unit_price, discount, vat_rate')
    .eq('invoice_id', inv.data.id)
    .order('line_no', { ascending: true });
  if (lines.error) return bad('Ophalen mislukt', 500);

  const total = Number(inv.data.total) || 0;
  const hash = sha256(
    JSON.stringify([
      inv.data.invoice_number, total, Number(inv.data.subtotal), Number(inv.data.vat_total),
      Number(inv.data.credit_applied), lines.data ?? [],
    ])
  );
  return {
    invoiceNumber: inv.data.invoice_number as string,
    status: String(inv.data.status),
    total,
    jobId: (inv.data.job_id as string | null) ?? null,
    hash,
  };
}

const isSnapshot = (v: Snapshot | Result): v is Snapshot => 'hash' in v;

/**
 * POST: propose sending one invoice to the customer of a job room. It goes
 * through the outbox as a tier 2 row (a person approves it, `ja A7`), never
 * straight to the customer. The text is fixed code, not model output. The
 * invoice must belong to this job, have lines and a total, be unpaid, and the
 * recipient must be the job's customer. Nothing is sent and Moneybird is not
 * called; Moneybird contacts are never touched from here.
 */
export async function proposeInvoice(supabase: SupabaseClient, raw: unknown): Promise<Result> {
  if (!isObject(raw)) return bad('Ongeldige invoer');
  if (!isUuid(raw.jobRoomId)) return bad('Ongeldige klus');
  const number = typeof raw.invoiceNumber === 'string' ? raw.invoiceNumber.trim() : '';
  if (!INVOICE_NUMBER.test(number)) return bad('Ongeldig factuurnummer');
  const mb = raw.moneybirdInvoiceId === undefined ? null : String(raw.moneybirdInvoiceId);
  if (mb !== null && !/^\d{6,20}$/.test(mb)) return bad('Ongeldig Moneybird-id');

  const room = await supabase
    .from('job_rooms')
    .select('id, job_id, customer_contact_id')
    .eq('id', raw.jobRoomId)
    .maybeSingle();
  if (room.error) return bad('Ophalen mislukt', 500);
  if (!room.data) return bad('Klus niet gevonden', 404);
  if (!room.data.customer_contact_id) return bad('Klus heeft geen klant', 409);

  const contact = await supabase
    .from('contacts')
    .select('id, display_name, role')
    .eq('id', room.data.customer_contact_id)
    .maybeSingle();
  if (contact.error) return bad('Ophalen mislukt', 500);
  if (!contact.data || contact.data.role !== 'customer') return bad('Ontvanger is geen klant', 409);

  const snap = await invoiceSnapshot(supabase, number);
  if (!isSnapshot(snap)) return snap;
  if (['betaald', 'written_off'].includes(snap.status)) return bad('Factuur is al afgehandeld', 409, { status: snap.status });
  if (!(snap.total > 0)) return bad('Factuur heeft geen bedrag', 409);
  if (!room.data.job_id || snap.jobId !== room.data.job_id) return bad('Factuur hoort niet bij deze klus', 409);

  const name = String(contact.data.display_name);
  const greeting = /^klant \d{4}$/i.test(name) ? 'Beste klant' : `Beste ${name}`;
  const body = `${greeting}, hierbij de factuur ${snap.invoiceNumber} van Autosleutel24, totaal € ${euro(snap.total)}. Betalen kan binnen 14 dagen. Bedankt!`;

  const proposed = await proposeOutbox(supabase, {
    jobRoomId: room.data.id,
    contactId: contact.data.id,
    audience: 'self_started',
    kind: `invoice:${snap.invoiceNumber}:${snap.hash.slice(0, 12)}`,
    tier: 2,
    body,
    attachment: {
      type: 'invoice_pdf',
      invoiceNumber: snap.invoiceNumber,
      total: snap.total,
      snapshotHash: snap.hash,
      ...(mb ? { moneybirdInvoiceId: mb } : {}),
    },
  });
  return proposed.status === 201 || proposed.status === 200
    ? { status: proposed.status, body: { ...proposed.body, invoiceNumber: snap.invoiceNumber, textHash: sha256(body), body } }
    : proposed;
}

/**
 * GET: is the invoice behind this outbox row still the one that was approved?
 * The transport asks this right before attaching it; `unchanged: false` means
 * propose again and get a new approval.
 */
export async function verifyInvoice(supabase: SupabaseClient, outboxId: string | null): Promise<Result> {
  if (!isUuid(outboxId)) return bad('Ongeldig bericht');
  const row = await supabase.from('job_outbox').select('id, state, attachment').eq('id', outboxId).maybeSingle();
  if (row.error) return bad('Ophalen mislukt', 500);
  const att = row.data?.attachment as Row | null | undefined;
  if (!row.data || !att || att.type !== 'invoice_pdf') return bad('Geen factuurbericht', 404);

  const snap = await invoiceSnapshot(supabase, String(att.invoiceNumber));
  if (!isSnapshot(snap)) return snap;
  const unchanged = snap.hash === att.snapshotHash && !['betaald', 'written_off'].includes(snap.status);
  return ok({ unchanged, state: row.data.state, invoiceNumber: snap.invoiceNumber, status: snap.status });
}
