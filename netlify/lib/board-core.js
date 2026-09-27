/**
 * board-core — the Lab opportunities board (casting calls, crew calls, collaborators).
 *
 * cleanPost()   everything a poster sends, cleaned field by field before it is
 *               stored (audit C2/M1/M7): known fields, types, lengths, enums,
 *               dates, safe ids, https links only.
 * publicPost()  what anyone may see: never the owner's uid or email, flags or reports.
 * scamFlags()   words that often mean a casting scam; flagged posts are held for review.
 */
const { DISCIPLINES } = require('./talent');

const ID = /^[a-z0-9]{2,40}$/;
const POST_ID = /^b[a-f0-9]{14}$/;
const APP_ID = /^a[a-f0-9]{20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const KINDS = ['casting', 'crew', 'collab'];
const FORMATS = ['Short', 'Feature', 'Series', 'Documentary', 'Music video', 'Commercial', 'Stage', 'Other'];
const PAY = ['paid', 'deferred', 'profit_share', 'unpaid'];
const ROLE_TYPES = ['lead', 'supporting', 'featured', 'extra', 'crew', 'other'];
const RATE_UNITS = ['day', 'week', 'flat'];
const FOLDERS = ['review', 'shortlist', 'hire', 'no'];
const LIMITS = { roles: 30, questions: 3, languages: 8 };

/* One line of text: no control characters or line breaks (these end up in email subjects). */
const str = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const oneOf = (v, list, dflt) => list.includes(v) ? v : dflt;
const date = v => (typeof v === 'string' && DATE.test(v) && !isNaN(Date.parse(v + 'T12:00:00Z'))) ? v : '';
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, n)) : null; };
const url = v => { const s = str(v, 300); return /^https:\/\/[^\s"'<>()\\]+$/i.test(s) ? s : ''; };
const list = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
const today = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);   // Johannesburg

function cleanRole(r, rid) {
  let lo = int(r.age_min, 1, 99), hi = int(r.age_max, 1, 99);
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  const rate = r.rate === '' || r.rate == null ? null : Math.max(0, Math.min(1e7, Math.round(Number(r.rate)) || 0)) || null;
  return {
    id: rid, name: str(r.name, 80) || 'Role', type: oneOf(r.type, ROLE_TYPES, 'other'),
    discipline: DISCIPLINES.includes(r.discipline) ? r.discipline : '',
    age_min: lo, age_max: hi,
    languages: (Array.isArray(r.languages) ? r.languages : String(r.languages || '').split(',')).map(l => str(l, 30)).filter(Boolean).slice(0, LIMITS.languages),
    skills: str(r.skills, 200), description: text(r.description, 800),
    rate, rate_unit: rate ? oneOf(r.rate_unit, RATE_UNITS, 'day') : null,
    minors: r.minors === true, nudity: r.nudity === true, open: r.open !== false
  };
}

/* The poster's fields only. Status, owner, dates made and counts are set by the server. */
function cleanPost(p) {
  p = p && typeof p === 'object' ? p : {};
  const seen = new Set(), roles = [];
  for (const r of list(p.roles)) {
    if (roles.length >= LIMITS.roles) break;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID.test(r.id) || seen.has(r.id)) continue;
    seen.add(r.id); roles.push(cleanRole(r, r.id));
  }
  let start = date(p.shoot_start), end = date(p.shoot_end);
  if (start && end && end < start) [start, end] = [end, start];
  return {
    kind: oneOf(p.kind, KINDS, 'casting'), title: str(p.title, 100), company: str(p.company, 80),
    format: oneOf(p.format, FORMATS, 'Other'), synopsis: text(p.synopsis, 1200),
    city: str(p.city, 60), country: str(p.country, 60), remote: p.remote === true,
    shoot_start: start, shoot_end: end, closes: date(p.closes),
    pay_type: oneOf(p.pay_type, PAY, 'unpaid'), pay_note: str(p.pay_note, 200),
    releases_on_4flieks: p.releases_on_4flieks === true,
    questions: list(p.questions).map(q => str(q, 160)).filter(Boolean).slice(0, LIMITS.questions),
    no_fees: p.no_fees === true,
    roles, prod_id: typeof p.prod_id === 'string' && ID.test(p.prod_id) ? p.prod_id : ''
  };
}

/* Checks a post must pass before it can be saved. Returns a message, or '' if fine. */
function problems(c) {
  if (c.title.length < 4) return 'Give the opportunity a title.';
  if (!c.no_fees) return 'Confirm that nobody will be asked to pay to apply, audition or be cast.';
  if (c.synopsis.length < 30) return 'Say a little more about the project (a few sentences).';
  if (!c.roles.length) return 'Add at least one role.';
  if (!c.closes) return 'Set a closing date.';
  if (c.closes < today()) return 'The closing date has passed.';
  if (c.closes > new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10)) return 'Close it within four months. You can extend it later.';
  if (!c.city && !c.remote) return 'Say where it is (or tick remote).';
  if (c.pay_type === 'paid' && !c.pay_note && !c.roles.some(r => r.rate)) return 'Paid work needs a rate on a role or a note on pay.';
  const minors = c.roles.find(r => r.minors && r.nudity);
  if (minors) return `"${minors.name}" can't be for under-18s and involve nudity.`;
  return '';
}

/* Words that often mean a scam. Flagged posts are held for the team, and nothing asks talent to pay. */
const SCAM = [
  [/\b(registration|joining|admin(istration)?|processing|audition|casting|portfolio|membership)\s+(fee|charge|cost)s?\b/i, 'asks for a fee'],
  [/\b(pay|send|deposit|transfer|e-?wallet|cash\s*send)\b[^.\n]{0,40}\b(r\s?\d|rand|fee|deposit|money)/i, 'asks for money'],
  [/\bdeposit\b/i, 'mentions a deposit'],
  [/\b(whats\s*app|wa\.me|telegram)\b[^.\n]{0,30}\bonly\b|\bonly\b[^.\n]{0,30}\b(whats\s*app|telegram)\b/i, 'contact off-platform only'],
  [/\b(send|share)\b[^.\n]{0,30}\b(nudes?|naked|lingerie|bikini)\b/i, 'asks for revealing photos'],
  [/\b(bank\s*details|id\s*(number|copy)|pin\s*code|otp)\b/i, 'asks for personal or bank details'],
  [/\b(guaranteed|easy)\s+(money|income|role)\b/i, 'promises that sound too good']
];
function scamFlags(c) {
  const blob = [c.title, c.company, c.synopsis, c.pay_note, ...c.questions, ...c.roles.flatMap(r => [r.name, r.skills, r.description])].join('\n');
  return [...new Set(SCAM.filter(([re]) => re.test(blob)).map(([, why]) => why))];
}

/* What anyone may see. */
function publicPost(id, p) {
  return {
    id, kind: p.kind, title: p.title, company: p.company, poster: p.poster_name || '', format: p.format, synopsis: p.synopsis,
    city: p.city, country: p.country, remote: !!p.remote, shoot_start: p.shoot_start || '', shoot_end: p.shoot_end || '', closes: p.closes,
    pay_type: p.pay_type, pay_note: p.pay_note || '', releases_on_4flieks: !!p.releases_on_4flieks,
    questions: list(p.questions), roles: list(p.roles), status: p.status, published_at: p.approved_at || null
  };
}
const isOpen = p => p && p.status === 'live' && p.closes >= today();

/* An applicant's own words. */
function cleanApplication(b, questionCount) {
  return {
    note: text(b.note, 1000),
    answers: list(b.answers).slice(0, questionCount).map(a => text(a, 400)),
    reel: url(b.reel),
    guardian: b.guardian && typeof b.guardian === 'object' && b.guardian.consent === true ? { name: str(b.guardian.name, 80), consent: true } : null
  };
}

module.exports = { ID, POST_ID, APP_ID, KINDS, PAY, FOLDERS, FORMATS, ROLE_TYPES, cleanPost, problems, scamFlags, publicPost, isOpen, cleanApplication, today, str, text };
