/**
 * The never-rules, in one place: no phone number, email address, licence plate
 * or secret crosses between parties or into a view that should not show it.
 *
 * Pure strings in, a verdict out. Used when a message is proposed (guardText),
 * when a briefing is built for a technician before the award, and when
 * /admin/live shows inbound text (maskSensitive). Everything is normalised
 * first so spelling a number out, adding zero-width characters or writing
 * "naam at gmail punt com" does not get past it.
 */

export type Audience = 'customer_reply' | 'technician' | 'self_started' | 'internal';
export type Finding = 'secret' | 'phone' | 'email' | 'plate';

const ZERO_WIDTH = new RegExp('[\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff\\u00ad]', 'g');

/** NFKC (full-width digits, ligatures), no zero-width or soft hyphens, lower case. */
export function normalize(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '').toLowerCase();
}

// --- digit words (nl, en, de, tr) --------------------------------------

const UNITS: Record<string, string> = {
  nul: '0', zero: '0', null: '0', 'sıfır': '0', sifir: '0',
  een: '1', 'eén': '1', one: '1', eins: '1', ein: '1', bir: '1',
  twee: '2', two: '2', zwei: '2', iki: '2',
  drie: '3', three: '3', drei: '3', 'üç': '3', uc: '3',
  vier: '4', four: '4', 'dört': '4', dort: '4',
  vijf: '5', five: '5', 'fünf': '5', funf: '5', fuenf: '5', 'beş': '5', bes: '5',
  zes: '6', six: '6', sechs: '6', 'altı': '6', alti: '6',
  zeven: '7', seven: '7', sieben: '7', yedi: '7',
  acht: '8', eight: '8', sekiz: '8',
  negen: '9', nine: '9', neun: '9', dokuz: '9',
};
const TENS: Record<string, string> = {
  tien: '10', ten: '10', twintig: '20', twenty: '20', dertig: '30', thirty: '30',
  veertig: '40', forty: '40', vijftig: '50', fifty: '50', zestig: '60', sixty: '60',
  zeventig: '70', seventy: '70', tachtig: '80', eighty: '80', negentig: '90', ninety: '90',
};
const L = 'a-zà-ÿıİğşçöü';
const word = (alts: string) => new RegExp(`(?<![${L}])(?:${alts})(?![${L}])`, 'g');
const COMPOUND = new RegExp(
  `(?<![${L}])(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(twintig|dertig|veertig|vijftig|zestig|zeventig|tachtig|negentig)(?![${L}])`,
  'g'
);
const UNIT_RE = word(Object.keys(UNITS).join('|'));
const TENS_RE = word(Object.keys(TENS).join('|'));

/** Digit words become digits, so "nul zes twaalf" style numbers show up as numbers. */
export function withDigitWords(normalized: string): string {
  return normalized
    .replace(COMPOUND, (_m, u: string, t: string) => ` ${TENS[t][0]}${UNITS[u]} `)
    .replace(TENS_RE, (m) => ` ${TENS[m]} `)
    .replace(UNIT_RE, (m) => ` ${UNITS[m]} `);
}

// --- phone ---------------------------------------------------------------

const DATE_OR_TIME = [
  // Only a date that stands alone: "06/12/34/56/78" is a phone number, not a date plus leftovers.
  /(?<![\d/.-])\d{4}-\d{2}-\d{2}(?![\d]|[-/.]\d)/g,
  /(?<![\d/.-])\d{1,2}[-/.]\d{1,2}[-/.](?:\d{4}|\d{2})(?![\d]|[-/.]\d)/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
];
const PHONE_RUN = /\+?\d(?:[\s().\-/,_·]*\d){8,}/g;

const stripDates = (t: string) => DATE_OR_TIME.reduce((s, re) => s.replace(re, ' '), t);
const digitCount = (s: string) => s.replace(/\D/g, '').length;

/** Nine digits or more in one run, whatever separates them. Dates and times do not count. */
function hasPhone(normalized: string): boolean {
  const t = stripDates(withDigitWords(normalized));
  return (t.match(PHONE_RUN) ?? []).some((m) => digitCount(m) >= 9);
}

// --- email -----------------------------------------------------------------

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;

function hasEmail(normalized: string): boolean {
  if (EMAIL.test(normalized)) return true;
  // "naam at gmail punt com", "naam (at) gmail [dot] com"
  const spelled = normalized
    .replace(/[([{]\s*(?:at|ät)\s*[)\]}]|(?<![a-z])(?:at|ät|apenstaartje)(?![a-z])/g, '@')
    .replace(/[([{]\s*dot\s*[)\]}]|(?<![a-z])(?:dot|punt)(?![a-z])/g, '.')
    .replace(/\s*([@.])\s*/g, '$1');
  return EMAIL.test(spelled);
}

// --- licence plate -----------------------------------------------------------

/** The Dutch sidecode layouts, compact (no separators): 6 characters. */
const PLATES = [
  /^[a-z]{2}\d{2}\d{2}$/, /^\d{2}[a-z]{2}\d{2}$/, /^\d{2}\d{2}[a-z]{2}$/,
  /^[a-z]{2}[a-z]{2}\d{2}$/, /^\d{2}[a-z]{2}[a-z]{2}$/, /^\d[a-z]{3}\d{2}$/,
  /^[a-z]{2}\d{3}[a-z]$/, /^[a-z]\d{3}[a-z]{2}$/, /^[a-z]{3}\d{2}[a-z]$/, /^\d[a-z]{2}\d{3}$/,
];
/** Group sizes of the Dutch layouts when written with separators (XX-99-99 is 222, XX-999-X is 231, 9-XXX-99 is 132 ...). */
const GROUPINGS = new Set(['222', '231', '132', '321', '123']);

/** Small words that appear between numbers in ordinary sentences ("08 om 10"); a plate window never spans one. */
const STOP = new Set(['om', 'op', 'en', 'of', 'in', 'de', 'het', 'uur', 'tot', 'met', 'bij', 'at', 'to', 'on', 'um', 'am', 've', 'is', 'na', 'te', 'van', 'tm', 'ca']);

const isPlate = (compact: string) =>
  compact.length === 6 && /\d/.test(compact) && /[a-z]/.test(compact) && PLATES.some((p) => p.test(compact));

/**
 * Plates with or without separators, any case: one 6-character chunk, or three
 * neighbouring chunks of a real layout's sizes joined by single separators.
 * Needs letters AND digits, so a date never matches, and the group sizes keep
 * "50 voor" from looking like 99-XX-XX.
 */
function hasPlate(normalized: string): boolean {
  const chunks = [...normalized.matchAll(/[a-z0-9]+/g)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  for (let i = 0; i < chunks.length; i++) {
    if (isPlate(chunks[i].text)) return true; // written without separators
    // written as three groups: XX-99-99, 99-XX-99, XX-999-X ... separators single, groups the right size
    if (i + 2 >= chunks.length) continue;
    const win = [chunks[i], chunks[i + 1], chunks[i + 2]];
    const gapsOk = [0, 1].every((k) => /^[-\s·_.]$/.test(normalized.slice(win[k].end, win[k + 1].start)));
    if (!gapsOk || win.some((c) => STOP.has(c.text))) continue;
    if (GROUPINGS.has(win.map((c) => c.text.length).join('')) && isPlate(win.map((c) => c.text).join(''))) return true;
  }
  return false;
}

// --- secrets -----------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[a-z0-9_-]{16,}/, /sk-ant-/, /sb_secret_/, /sbp_[a-z0-9]{20,}/,
  /-----begin [a-z ]*private key-----/,
  /\b\d{8,10}:[a-z0-9_-]{35}\b/, // Telegram bot token
  /xox[abprs]-[a-z0-9-]{10,}/, /xapp-[a-z0-9-]{10,}/,
  /eyj[a-z0-9_-]{15,}\.[a-z0-9_-]{5,}/, // JWT
  /\b(?:ghp|gho|ghs|github_pat)_[a-z0-9_]{20,}/, /\bakia[0-9a-z]{16}\b/,
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const isKeyLike = (t: string) => /\d/.test(t) && /[A-Za-z]/.test(t) && entropy(t) >= 4;

/** A long, mixed, random-looking token is treated as a key even if it matches no known format. */
function hasHighEntropyToken(original: string): boolean {
  return (original.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some(isKeyLike);
}

function hasSecret(original: string, normalized: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(normalized)) || hasHighEntropyToken(original.normalize('NFKC'));
}

// --- verdicts ------------------------------------------------------------------

/** The first rule a text breaks, or null. */
export function findSensitive(text: string): Finding | null {
  const n = normalize(text);
  if (hasSecret(text, n)) return 'secret';
  if (hasPhone(n)) return 'phone';
  if (hasEmail(n)) return 'email';
  if (hasPlate(n)) return 'plate';
  return null;
}

/**
 * At the moment a row is proposed. A key-like string is refused for everyone.
 * Contact details are refused for every audience except `internal`, which is
 * only ever derived from a staff or owner contact, never chosen by a caller.
 */
export function guardText(text: string, audience: Audience): string | null {
  const found = findSensitive(text);
  if (found === 'secret') return 'secret';
  if (audience === 'internal') return null;
  return found;
}

/** Shows only the last 4 digits of a phone-like run. Dates and times stay. */
export function maskPhones(text: string): string {
  return text.replace(PHONE_RUN, (m) => (digitCount(stripDates(m)) >= 9 ? `••••${m.replace(/\D/g, '').slice(-4)}` : m));
}

const REASON_NL: Record<Finding, string> = {
  secret: 'een sleutel',
  phone: 'een telefoonnummer',
  email: 'een e-mailadres',
  plate: 'een kenteken',
};

/** Hides secrets in place, whatever the surrounding text. Used before a body is stored. */
export function maskSecrets(text: string): string {
  let out = text.normalize('NFKC').replace(ZERO_WIDTH, '');
  out = out.replace(/[A-Za-z0-9+/_=-]{32,}/g, (t) => (isKeyLike(t) ? '[sleutel]' : t));
  for (const p of SECRET_PATTERNS) out = out.replace(new RegExp(p.source, 'gi'), '[sleutel]');
  return out;
}

/**
 * For screens: mask what can be masked in place, and if anything sensitive is
 * still detectable afterwards (a number spelled out, an address written with
 * "punt"), hide the whole text rather than guess where it is.
 */
export function maskSensitive(text: string): string {
  let out = maskSecrets(text);
  out = out.replace(new RegExp(EMAIL.source, 'gi'), '[e-mail]');
  out = maskPhones(out);
  const left = findSensitive(out.replace(/••••\d{4}|\[sleutel\]|\[e-mail\]/g, ' '));
  return left ? `[tekst verborgen: bevat ${REASON_NL[left]}]` : out;
}
