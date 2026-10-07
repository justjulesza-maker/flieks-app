/**
 * crm — who may get which email, the campaigns, and the proof (POPIA).
 *
 * Three kinds of email, each with its own switch per address:
 *   news            new films and 4flieks news for viewers (direct marketing)
 *   filmmaker_news  what's new for filmmakers releasing on 4flieks
 *   alerts          films a person saved or filmmakers they follow
 * Receipts, password resets, payouts and support replies are not marketing and
 * are not affected by any of these.
 *
 * Who counts as having agreed to viewer news (POPIA s69):
 *   - they said yes (sign-up box, profile, the one-time question email, /email):
 *     basis 'consent'
 *   - they bought a film or episode (s69(3) customer exception), have never
 *     said no, and every mail lets them stop: basis 'customer'
 * Everyone else gets no viewer news. They may be asked once, by the consent
 * email (s69(2)), and never again (asked_at).
 *
 * Filmmakers get filmmaker news because they release films here under the
 * distribution agreement, until they switch it off.
 *
 * Database (server only, no client rules, so browsers can't read or write it):
 *   flieks_crm/prefs/{ekey}        { email, uid, news, news_at, news_source,
 *                                    filmmaker_news, alerts, asked_at, updated_at }
 *                                  news: true | false | null (never chose)
 *   flieks_crm/log/{ekey}/{id}     { field, from, to, source, wording, by, note, at }
 *   flieks_crm/campaigns/{id}      the campaign, its status and counts
 *   flieks_crm/sends/{id}/{ekey}   { at, ok }  one email per address per campaign
 *   flieks_crm/weekly/{week}       { campaign, films, at }  the Monday draft
 *
 * ekey is watchlist.emailKey(email): a hash of the lower-cased address, the same
 * key the watchlist already uses, so one person is one record however they came.
 */
const crypto = require('crypto');
const ops = require('./ops-core');
const wl = require('./watchlist');

const SITE = ops.SITE;
const FROM = () => process.env.CRM_EMAIL_FROM || process.env.OPS_EMAIL_FROM || process.env.SUPPORT_FROM || '4flieks <hello@4flieks.com>';
const REPLY_TO = () => process.env.CRM_REPLY_TO || 'hello@4flieks.com';
const SENDER_LINE = '4flieks is run by DiscovrTV (Pty) Ltd, 3 Fisant Avenue, Fourways, Johannesburg 2191, South Africa.';

const FIELDS = ['news', 'filmmaker_news', 'alerts'];
const FIELD_NAMES = { news: 'New films and 4flieks news', filmmaker_news: 'Filmmaker news', alerts: 'Films I saved and filmmakers I follow' };

/* Exactly what people were shown when they said yes or no. Kept so we can show
   what someone agreed to. Change the wording → add a new version, never edit one. */
const WORDING = {
  'signup-v1': 'Send me new films and 4flieks news by email. I can stop any time.',
  'signup-filmmaker-v1': 'Also send me new films and 4flieks news for viewers. I can stop any time. (Filmmaker updates come with your account.)',
  'profile-v1': 'Get new films by email? Yes please / No thanks',
  'consent-email-v1': 'Would you like us to email you when new African films arrive on 4flieks? Yes, keep me posted',
  'prefs-page-v1': 'Email preferences page (/email)',
  'unsubscribe-link-v1': 'Unsubscribe link in an email',
  'one-click-v1': 'One-click unsubscribe from the mail app (List-Unsubscribe)',
  'admin-v1': 'Changed by a 4flieks admin at the person\'s request',
  'confirm-email-v1': 'Confirm your 4flieks emails: Yes, send me new films'
};
const SOURCES = ['signup:home', 'signup:lab', 'signup:talent', 'signup:filmmaker', 'profile', 'consent-email', 'confirm-email', 'prefs-page', 'unsubscribe-link', 'one-click', 'admin'];

const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okKey = k => typeof k === 'string' && /^e_[a-f0-9]{24}$/.test(k);
const okId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(id);
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const mask = e => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}` : ''; };

/* ---------- links that manage one address, without signing in ---------- */

const tokenSecret = () => {
  if (!process.env.FIREBASE_DB_SECRET) throw new Error('FIREBASE_DB_SECRET is not set');   // never sign links with a guessable key
  return crypto.createHash('sha256').update(process.env.FIREBASE_DB_SECRET + ':email-prefs').digest();
};
const prefsToken = ekey => crypto.createHmac('sha256', tokenSecret()).update(String(ekey)).digest('base64url').slice(0, 32);
function checkToken(ekey, t) {
  if (!okKey(ekey) || typeof t !== 'string' || t.length !== 32) return false;
  const a = Buffer.from(prefsToken(ekey)), b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const prefsUrl = (ekey, extra = '') => `${SITE}/email?k=${ekey}&t=${prefsToken(ekey)}${extra}`;
const oneClickUrl = (ekey, scope) => `${SITE}/.netlify/functions/flieks-email-prefs?k=${ekey}&t=${prefsToken(ekey)}&scope=${scope}`;

/* ---------- preferences and the log ---------- */

/* A write that didn't land must not look like it did (an unsubscribe that wasn't saved). */
async function write(path, data, method = 'PUT') {
  const r = await ops.dbWrite(path, data, method);
  if (r && r.status >= 300) throw new Error(`db write ${path}: ${r.status}`);
  return r;
}

async function getPrefs(ekey) { return okKey(ekey) ? (await ops.dbGet(`flieks_crm/prefs/${ekey}`)) || null : null; }

/**
 * Record a choice. Every change is logged with where it came from and the words
 * the person saw. Returns the new prefs.
 *   onlyIfUnset: don't overwrite an earlier choice (sign-up after a "no" by link).
 */
async function setPref({ email, uid = null, field, value, source, wording, by = null, note = null, onlyIfUnset = false }) {
  if (!FIELDS.includes(field)) throw new Error('unknown field');
  if (!SOURCES.includes(source)) throw new Error('unknown source');
  if (!wl.validEmail(email || '')) throw new Error('bad email');
  if (typeof value !== 'boolean') throw new Error('value must be true or false');
  const ekey = wl.emailKey(email);
  const prev = (await getPrefs(ekey)) || {};
  const from = prev[field] === undefined ? null : prev[field];
  if (onlyIfUnset && from !== null) return { ekey, prefs: prev, changed: false };
  const now = Date.now();
  // Only the fields this change touches, so two changes at once can't undo each other.
  const patch = { email: String(email).trim(), [field]: value, updated_at: now };
  if (uid) patch.uid = uid;
  if (field === 'news') { patch.news_at = now; patch.news_source = source; if (value) patch.news_pending = null; }
  await write(`flieks_crm/prefs/${ekey}`, patch, 'PATCH');
  const next = { ...prev, ...patch };
  if (from !== value) {
    await write(`flieks_crm/log/${ekey}/${newId()}`, {
      field, from, to: value, source, wording: WORDING[wording] ? wording : null, by, note: note ? str(note, 300) : null, at: now
    });
  }
  return { ekey, prefs: next, changed: from !== value };
}

/* ---------- who is who ---------- */

/** A real sale to this person (not a gift they redeemed, not a test payment). */
const isSale = p => p && typeof p === 'object' && p.status === 'complete' && p.mode !== 'test' && p.source !== 'gift' && Number(p.amount) > 0;

/** Viewer-news status for one person. */
function newsStatus(prefs, buyer) {
  const p = prefs || {};
  if (p.news === true) return { status: 'subscribed', basis: 'consent', eligible: true };
  if (p.news === false) return { status: 'unsubscribed', basis: null, eligible: false };
  if (buyer) return { status: 'customer', basis: 'customer', eligible: true };
  return { status: p.asked_at ? 'asked' : 'not asked', basis: null, eligible: false };
}

/** Everyone with an account, with what they bought and what they agreed to. */
async function people() {
  const [users, purchases, prefs] = await Promise.all([
    ops.dbGet('flieks_users'), ops.dbGet('flieks_purchases'), ops.dbGet('flieks_crm/prefs')
  ]);
  const P = prefs || {};
  // One person can have two accounts on one address: they're a customer if either bought.
  const boughtByKey = new Set();
  for (const [uid, u] of Object.entries(users || {})) {
    const e = u && str(u.email, 200);
    if (e && wl.validEmail(e) && Object.values((purchases || {})[uid] || {}).some(isSale)) boughtByKey.add(wl.emailKey(e));
  }
  const out = [];
  for (const [uid, u] of Object.entries(users || {})) {
    if (!u || typeof u !== 'object') continue;
    const email = str(u.email, 200);
    const ekey = wl.validEmail(email) ? wl.emailKey(email) : null;
    const mine = Object.values((purchases || {})[uid] || {});
    const sales = mine.filter(isSale);
    const pr = ekey ? P[ekey] || null : null;
    const ns = newsStatus(pr, sales.length > 0 || (ekey && boughtByKey.has(ekey)));
    const role = u.role || 'viewer';
    out.push({
      uid, ekey, name: str(u.name || u.display_name, 80), email, role,
      created_at: u.created_at || null, joined_via: u.joined_via || null,
      buyer: sales.length > 0, bought: sales.length,
      spend: Math.round(sales.reduce((s, p) => s + Number(p.amount || 0), 0) * 100) / 100,
      last_bought: sales.reduce((m, p) => Math.max(m, p.purchased_at || p.created_at || 0), 0) || null,
      news: ns.status, basis: ns.basis, news_ok: ns.eligible,
      filmmaker_news: role === 'filmmaker' || role === 'filmmaker_pending' ? !(pr && pr.filmmaker_news === false) : null,
      alerts: !(pr && pr.alerts === false),
      asked_at: (pr && pr.asked_at) || null
    });
  }
  return out;
}

/* Who a campaign goes to. One entry per address. */
const AUDIENCES = {
  viewers:    { label: 'Viewers: said yes, or bought a film', who: p => p.news_ok, why: p => p.basis === 'customer' ? 'customer' : 'news' },
  consented:  { label: 'Viewers who said yes (strictest)', who: p => p.news === 'subscribed', why: () => 'news' },
  filmmakers: { label: 'Filmmakers releasing on 4flieks', who: p => (p.role === 'filmmaker') && p.filmmaker_news, why: () => 'filmmaker' },
  applicants: { label: 'Filmmaker applicants (pending)', who: p => p.role === 'filmmaker_pending' && p.filmmaker_news, why: () => 'applicant' },
  consent:    { label: 'Everyone not yet asked (one-time question)', who: p => p.news === 'not asked', why: () => 'consent' }
};
const AUDIENCE_FOR_KIND = { newsletter: ['viewers', 'consented'], weekly: ['viewers', 'consented'], filmmaker: ['filmmakers', 'applicants'], consent: ['consent'] };

async function audience(name, list = null) {
  const a = AUDIENCES[name];
  if (!a) throw new Error('unknown audience');
  const all = list || await people();
  const seen = new Set(), out = [];
  for (const p of all) {
    if (!p.ekey || seen.has(p.ekey) || !a.who(p)) continue;
    seen.add(p.ekey);
    out.push({ ekey: p.ekey, email: p.email, uid: p.uid, name: p.name, why: a.why(p) });
  }
  return out;
}

async function counts(list = null) {
  const all = list || await people();
  const c = { accounts: all.length, viewers: 0, filmmakers: 0, applicants: 0, buyers: 0,
    subscribed: 0, customer: 0, unsubscribed: 0, asked: 0, not_asked: 0, alerts_off: 0, filmmaker_news_off: 0 };
  for (const p of all) {
    if (p.role === 'filmmaker') c.filmmakers++; else if (p.role === 'filmmaker_pending') c.applicants++; else if (p.role !== 'admin') c.viewers++;
    if (p.buyer) c.buyers++;
    c[p.news.replace(' ', '_')]++;
    if (!p.alerts) c.alerts_off++;
    if (p.filmmaker_news === false) c.filmmaker_news_off++;
  }
  const aud = {};
  for (const k of Object.keys(AUDIENCES)) aud[k] = (await audience(k, all)).length;
  return { ...c, audiences: aud };
}

/* ---------- campaigns ---------- */

const KINDS = ['newsletter', 'weekly', 'filmmaker', 'consent'];
const httpsUrl = u => { const s = str(u, 500); return /^https:\/\/[^\s<>"']+$/i.test(s) ? s : ''; };

/** Clean what the admin page sends. Throws with a message the admin can act on. */
function cleanCampaign(b, prev = {}) {
  const kind = KINDS.includes(b.kind) ? b.kind : prev.kind || 'newsletter';
  const allowed = AUDIENCE_FOR_KIND[kind];
  const aud = allowed.includes(b.audience) ? b.audience : allowed.includes(prev.audience) ? prev.audience : allowed[0];
  const c = {
    kind, audience: aud,
    subject: str(b.subject, 150),
    preheader: str(b.preheader, 150),
    kicker: str(b.kicker, 40),
    heading: str(b.heading, 120),
    intro: str(b.intro, 4000),
    films: Array.isArray(b.films) ? b.films.filter(wl.okFilm).slice(0, 8) : [],
    cta_label: str(b.cta_label, 40),
    cta_url: httpsUrl(b.cta_url),
    signoff: str(b.signoff, 80)
  };
  if (kind === 'consent') {
    // s69(2): the question email asks for consent and nothing else. Fixed words, no films, no offers.
    Object.assign(c, { films: [], cta_label: '', cta_url: '', kicker: '', intro: '', heading: '' });
    if (!c.subject) c.subject = 'Can we email you about new films?';
  }
  if (kind !== 'consent' && b.cta_url && !c.cta_url) throw new Error('The button link must start with https://');
  if (!c.subject) throw new Error('Add a subject line.');
  return c;
}

async function filmsById(ids) {
  const out = [];
  for (const id of ids || []) {
    const f = await ops.dbGet(`flieks_films/${id}`);
    if (f && (f.status === 'live' || f.status === 'soon')) out.push({ ...f, id });
  }
  return out;
}

/* Paragraphs from blank lines; links made clickable after escaping. */
function textToHtml(t) {
  return String(t || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p =>
    `<p style="font-size:16px;line-height:1.6;margin:0 0 16px">${escHtml(p).replace(/\n/g, '<br>')
      .replace(/(https:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" style="color:#B0441A">$1</a>')}</p>`).join('\n');
}

const FOOTERS = {
  news: 'You\'re getting this because you said yes to 4flieks news.',
  customer: 'You\'re getting this because you watched a film on 4flieks. We only email about new films and 4flieks news.',
  filmmaker: 'You\'re getting this because you release films on 4flieks.',
  applicant: 'You\'re getting this because you applied to release films on 4flieks.',
  consent: 'We\'re asking once. If you don\'t answer, we won\'t send you new-film emails (unless you buy a film from us one day, and you can stop those any time too).',
  confirm: 'You (or someone using this address) asked for 4flieks news. If it wasn\'t you, ignore this email and you won\'t hear from us.',
  test: 'Test send. Real recipients see why they are getting this email here.'
};
const SCOPE_FOR = { news: 'news', customer: 'news', filmmaker: 'filmmaker_news', applicant: 'filmmaker_news', consent: 'news', confirm: 'news', test: 'news' };

const btn = (href, label, primary = true) =>
  `<a href="${escHtml(href)}" style="display:inline-block;padding:14px 24px;border-radius:10px;font:700 16px/1 Arial,Helvetica,sans-serif;text-decoration:none;` +
  (primary ? 'background:#D85A2C;color:#1C1512' : 'background:#FBF6EC;color:#1C1512;border:1px solid #DCCFB9') + `">${escHtml(label)}</a>`;

function filmCard(f) {
  const url = wl.filmUrl(f), poster = wl.posterOf(f);
  const price = f.status === 'soon' ? 'Coming soon' : f.free ? 'Free to watch' : `Rent R${f.price_rent ?? 25} · Own R${f.price_own ?? 49}`;
  const by = [f.filmmaker, f.filmmaker_location].filter(Boolean).join(', ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF6EC;border:1px solid #DCCFB9;border-radius:12px;margin:0 0 12px"><tr>
  ${poster ? `<td width="112" style="padding:12px 0 12px 12px;vertical-align:top"><a href="${escHtml(url)}"><img src="${escHtml(poster)}" width="100" alt="${escHtml(f.title)}" style="display:block;width:100px;height:auto;border-radius:8px;border:0"></a></td>` : ''}
  <td style="padding:14px 16px;vertical-align:top;font-family:Arial,Helvetica,sans-serif;color:#1C1512">
    <p style="font-size:18px;font-weight:700;margin:0 0 4px">${escHtml(f.title)}</p>
    ${by ? `<p style="font-size:13px;color:#54483F;margin:0 0 8px">A film by ${escHtml(by)}</p>` : ''}
    ${f.synopsis ? `<p style="font-size:14px;line-height:1.5;margin:0 0 10px">${escHtml(String(f.synopsis).slice(0, 220))}${String(f.synopsis).length > 220 ? '…' : ''}</p>` : ''}
    <p style="font-size:13px;font-weight:700;margin:0 0 10px">${escHtml(price)}</p>
    <a href="${escHtml(url)}" style="font:700 14px Arial,Helvetica,sans-serif;color:#B0441A;text-decoration:none">${f.status === 'soon' ? 'Tell me when it\'s live' : 'Watch now'} →</a>
  </td></tr></table>`;
}

/**
 * The email for one person. why: news | customer | filmmaker | applicant | consent | test.
 * Every one names the sender, says why they got it and links to stop it (POPIA
 * s69(4), ECTA s45). Consent emails carry yes/no links instead of content.
 */
function render(c, films, { ekey, name, why }) {
  const first = str(name, 80).split(/\s+/)[0] || '';
  const hi = first ? `Hi ${first},` : 'Hi,';
  const scope = SCOPE_FOR[why] || 'news';
  const manage = ekey ? prefsUrl(ekey) : `${SITE}/email`;
  const unsub = ekey ? prefsUrl(ekey, `&unsub=${scope}`) : `${SITE}/email`;
  const footer = FOOTERS[why] || FOOTERS.news;

  let body = '', text = [];
  if (c.kind === 'confirm') {
    const yes = prefsUrl(ekey, '&yes=1&via=confirm');
    body = `<h1 style="font-size:26px;line-height:1.25;margin:0 0 14px">Confirm your 4flieks emails</h1>
  <p style="font-size:16px;line-height:1.6;margin:0 0 16px">${escHtml(hi)} you asked us to email you when new films arrive on 4flieks. Please confirm it was you.</p>
  <p style="margin:0 0 28px">${btn(yes, 'Yes, send me new films')}</p>`;
    text = [hi, '', 'You asked us to email you when new films arrive on 4flieks. Please confirm it was you:', yes];
  } else if (c.kind === 'consent') {
    const yes = ekey ? prefsUrl(ekey, '&yes=1') : `${SITE}/email`;
    const no = ekey ? prefsUrl(ekey, '&no=1') : `${SITE}/email`;
    body = `<h1 style="font-size:26px;line-height:1.25;margin:0 0 14px">Can we email you about new films?</h1>
  <p style="font-size:16px;line-height:1.6;margin:0 0 16px">${escHtml(hi)} you have a 4flieks account. New African independent films arrive on 4flieks every week, and we'd like to let you know when they do.</p>
  <p style="font-size:16px;line-height:1.6;margin:0 0 22px">We'll only do that if you say yes. It's one email a week at most, and you can stop any time.</p>
  <p style="margin:0 0 12px">${btn(yes, 'Yes, keep me posted')}</p>
  <p style="margin:0 0 28px">${btn(no, 'No thanks', false)}</p>`;
    text = [hi, '', 'You have a 4flieks account. New African independent films arrive on 4flieks every week, and we\'d like to let you know when they do.', '',
      'We\'ll only do that if you say yes. It\'s one email a week at most, and you can stop any time.', '', `Yes, keep me posted: ${yes}`, `No thanks: ${no}`];
  } else {
    body = `${c.kicker ? `<p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#B0441A;font-weight:700;margin:0 0 6px">${escHtml(c.kicker)}</p>` : ''}
  ${c.heading ? `<h1 style="font-size:28px;line-height:1.2;margin:0 0 16px">${escHtml(c.heading)}</h1>` : ''}
  <p style="font-size:16px;line-height:1.6;margin:0 0 16px">${escHtml(hi)}</p>
  ${textToHtml(c.intro)}
  ${films.length ? `<div style="margin:6px 0 18px">${films.map(filmCard).join('')}</div>` : ''}
  ${c.cta_url && c.cta_label ? `<p style="margin:6px 0 26px">${btn(c.cta_url, c.cta_label)}</p>` : ''}
  <p style="font-size:15px;margin:0 0 28px">${escHtml(c.signoff || 'The 4flieks team')}</p>`;
    text = [hi, '', ...String(c.intro || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).flatMap(s => [s, '']),
      ...films.flatMap(f => [`${f.title}${f.filmmaker ? ` (a film by ${f.filmmaker})` : ''}`, wl.filmUrl(f), '']),
      ...(c.cta_url && c.cta_label ? [`${c.cta_label}: ${c.cta_url}`, ''] : []), c.signoff || 'The 4flieks team'];
  }

  const unsubWord = scope === 'filmmaker_news' ? 'Stop filmmaker news' : c.kind === 'consent' ? 'Never ask me again' : 'Unsubscribe';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#F2EADA">
${c.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escHtml(c.preheader)}</div>` : ''}
<div style="max-width:560px;margin:0 auto;padding:28px 18px;font-family:Arial,Helvetica,sans-serif;color:#1C1512">
  <div style="background:#1C1512;border-radius:14px;padding:22px 22px 18px;margin:0 0 26px">
    <img src="${SITE}/brand/png/logo-reversed-2x.png" width="220" alt="4flieks" style="display:block;width:220px;height:auto;border:0">
  </div>
  ${body}
  <div style="border-top:1px solid #DCCFB9;padding-top:16px">
    <p style="font-size:12.5px;line-height:1.55;color:#6E6157;margin:0 0 8px">${escHtml(footer)}
      <a href="${escHtml(unsub)}" style="color:#6E6157">${unsubWord}</a> · <a href="${escHtml(manage)}" style="color:#6E6157">Email preferences</a> · <a href="${SITE}/privacy" style="color:#6E6157">Privacy</a></p>
    <p style="font-size:12px;line-height:1.5;color:#8A7D72;margin:0">${escHtml(SENDER_LINE)}</p>
  </div>
</div></body></html>`;

  text.push('', '—', footer, `${unsubWord}: ${unsub}`, `Email preferences: ${manage}`, SENDER_LINE);
  const headers = ekey ? {
    'List-Unsubscribe': `<${oneClickUrl(ekey, scope)}>, <mailto:privacy@4flieks.com?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  } : {};
  return { subject: c.subject, html, text: text.join('\n'), headers };
}

/** Put each address on its prefs record (email and uid only, never a choice), one write. */
async function rememberAddresses(list) {
  const patch = {};
  for (const p of list) if (okKey(p.ekey) && p.email) { patch[`${p.ekey}/email`] = p.email; if (p.uid) patch[`${p.ekey}/uid`] = p.uid; }
  if (Object.keys(patch).length) await write('flieks_crm/prefs', patch, 'PATCH');
}

/** Has anyone with this address bought from us (any of their accounts)? */
async function customerKey(ekey) {
  const [users, purchases] = await Promise.all([ops.dbGet('flieks_users'), ops.dbGet('flieks_purchases')]);
  return Object.entries(users || {}).some(([uid, u]) => u && wl.validEmail(u.email || '') && wl.emailKey(str(u.email, 200)) === ekey &&
    Object.values((purchases || {})[uid] || {}).some(isSale));
}

/** The address behind a key, when its prefs record doesn't have it yet. */
async function emailForKey(ekey) {
  const p = await getPrefs(ekey);
  if (p && p.email) return { email: p.email, uid: p.uid || null };
  for (const [uid, u] of Object.entries((await ops.dbGet('flieks_users')) || {})) {
    if (u && wl.validEmail(u.email || '') && wl.emailKey(u.email) === ekey) return { email: u.email, uid };
  }
  return null;
}

/**
 * Double opt-in. A yes from an address nobody has proved they own (account email not
 * verified) is held as pending until they press the button in this email, so nobody
 * can sign someone else up. At most one of these a day per address.
 */
async function sendConfirm({ email, uid = null, name = '', source, wording }, sendImpl = null) {
  const ekey = wl.emailKey(email);
  const prev = (await getPrefs(ekey)) || {};
  if (prev.news === true) return { ok: true, already: true };
  if (prev.news_pending && Date.now() - (prev.news_pending.at || 0) < 864e5) return { ok: true, pending: true, resent: false };
  await write(`flieks_crm/prefs/${ekey}`, { email: String(email).trim(), ...(uid ? { uid } : {}), news_pending: { at: Date.now(), source, wording }, updated_at: Date.now() }, 'PATCH');
  const m = render({ kind: 'confirm', subject: 'Confirm: new films from 4flieks' }, [], { ekey, name, why: 'confirm' });
  const r = await (sendImpl || sendBatch)([{ to: String(email).trim(), ...m }]);
  return { ok: !!r.ok, pending: true, resent: true, reason: r.reason };
}

/* Resend's batch endpoint takes up to 100 emails per call. */
async function sendBatch(msgs, fetchImpl = fetch) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'RESEND_API_KEY is not set' };
  const r = await fetchImpl('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(msgs.map(m => ({ from: FROM(), reply_to: REPLY_TO(), ...m, to: [m.to] })))
  });
  if (r.ok) return { ok: true };
  const why = await r.text().catch(() => '');
  return { ok: false, status: r.status, reason: `resend ${r.status}${why ? ': ' + why.slice(0, 160) : ''}` };
}

/**
 * Send a queued campaign. Safe to run again: anyone already sent to is skipped,
 * and who may receive it is worked out now, not when it was written, so anyone
 * who unsubscribed in between is left out.
 */
async function runCampaign(id, { send = sendBatch, pauseMs = 600 } = {}) {
  if (!okId(id)) return { ok: false, reason: 'bad id' };
  return ops.withLock(`crm_send_${id}`, async () => {
    const c = await ops.dbGet(`flieks_crm/campaigns/${id}`);
    if (!c) return { ok: false, reason: 'campaign not found' };
    if (!['queued', 'sending'].includes(c.status)) return { ok: false, reason: `campaign is ${c.status}` };
    await ops.dbWrite(`flieks_crm/campaigns/${id}`, { status: 'sending', started_at: c.started_at || Date.now() }, 'PATCH');

    const [list, done, films] = await Promise.all([audience(c.audience), ops.dbGet(`flieks_crm/sends/${id}`), filmsById(c.films)]);
    const already = done || {};
    const todo = list.filter(r => !(already[r.ekey] && already[r.ekey].ok));
    let sent = Object.values(already).filter(x => x && x.ok).length, failed = 0, lastError = null;

    const field = SCOPE_FOR[AUDIENCES[c.audience].why({ basis: 'consent' })] || 'news';
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      // Anyone who said no since the list was made is dropped here, batch by batch.
      // The one-time question also skips anyone asked or who chose in the meantime.
      const fresh = (await ops.dbGet('flieks_crm/prefs')) || {};
      for (let j = chunk.length - 1; j >= 0; j--) {
        const f = fresh[chunk[j].ekey] || {};
        if (f[field] === false || (c.kind === 'consent' && (f.asked_at || f.news != null))) chunk.splice(j, 1);
      }
      if (!chunk.length) continue;
      // Their unsubscribe link finds their address by key, so make sure it's on file.
      const at = Date.now();
      await rememberAddresses(chunk);
      // Mark the question as asked before it goes: if the run dies mid-way, the worst case
      // is someone not asked, never someone asked twice.
      if (c.kind === 'consent') {
        await write('flieks_crm/prefs', Object.fromEntries(chunk.map(p => [`${p.ekey}/asked_at`, at])), 'PATCH');
      }
      const results = await sendChunk(send, chunk.map(p => ({ to: p.email, ...render(c, films, p) })));
      await write(`flieks_crm/sends/${id}`, Object.fromEntries(chunk.map((p, j) => [p.ekey, { at, ok: results[j].ok }])), 'PATCH');
      for (const r of results) { if (r.ok) sent++; else { failed++; lastError = r.reason; } }
      await write(`flieks_crm/campaigns/${id}`, { progress: { sent, failed, total: list.length, at: Date.now() } }, 'PATCH');
      if (i + 100 < todo.length && pauseMs) await new Promise(res => setTimeout(res, pauseMs));
    }
    const result = { status: failed && !sent ? 'failed' : 'sent', sent_at: Date.now(),
      progress: { sent, failed, total: list.length, at: Date.now() }, error: lastError };
    await write(`flieks_crm/campaigns/${id}`, result, 'PATCH');
    return { ok: true, ...result };
  }, { ttl: 900e3, wait: 1e3 });
}

/* One batch call; if Resend refuses the batch outright (one bad address fails all
   100), send that batch one by one so the good addresses still get it. */
async function sendChunk(send, msgs) {
  const r = await send(msgs);
  if (r.ok) return msgs.map(() => ({ ok: true }));
  if (!(r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429) || msgs.length === 1) {
    return msgs.map(() => ({ ok: false, reason: r.reason }));
  }
  const out = [];
  for (const m of msgs) { const x = await send([m]); out.push(x.ok ? { ok: true } : { ok: false, reason: x.reason }); }
  return out;
}

/** Mark a run that died as failed, so the admin can resume it. */
async function markFailed(id, reason) {
  if (!okId(id)) return;
  await ops.dbWrite(`flieks_crm/campaigns/${id}`, { status: 'failed', error: String(reason || 'stopped').slice(0, 200) }, 'PATCH').catch(() => {});
}

const jobSecret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':crm-send').digest('hex');

/** Start crm-send-background (it answers 202 at once). */
async function startSend(id, fetchImpl = fetch) {
  const base = process.env.URL || 'https://4flieks.com';
  const kick = await fetchImpl(`${base}/.netlify/functions/crm-send-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': jobSecret() },
    body: JSON.stringify({ id })
  }).catch(e => ({ ok: false, status: 0, statusText: e.message }));
  return kick.ok || kick.status === 202;
}

/* ---------- the Monday draft ---------- */

/** Monday of this week in Johannesburg, as YYYY-MM-DD. */
function weekKey(t = Date.now()) {
  const d = new Date(ops.dayStart(t) + ops.SA);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Draft "New on 4flieks this week" from films that went live in the last 7 days.
 * Never sends. Returns { made:false } when there's nothing new or it's done already.
 */
async function draftWeekly({ now = Date.now(), force = false } = {}) {
  const wk = weekKey(now);
  const weeks = (await ops.dbGet('flieks_crm/weekly')) || {};
  const done = weeks[wk];
  if (done && !force) return { made: false, reason: 'already drafted this week', week: wk, campaign: done.campaign };
  // A film taken down and put back gets a new published_at: don't announce it as new twice.
  const before = new Set(Object.entries(weeks).filter(([k]) => k !== wk).flatMap(([, w]) => (w && w.films) || []));
  const films = Object.entries((await ops.dbGet('flieks_films')) || {})
    .map(([id, f]) => ({ ...f, id }))
    .filter(f => f.status === 'live' && !f.premiere && !before.has(f.id) && (f.published_at || 0) >= now - 7 * 864e5 && (f.published_at || 0) <= now)
    .sort((a, b) => (b.published_at || 0) - (a.published_at || 0)).slice(0, 8);
  if (!films.length) return { made: false, reason: 'no new films this week', week: wk };
  const n = films.length;
  const id = newId();
  const c = {
    ...cleanCampaign({
      kind: 'weekly', audience: 'viewers',
      subject: n === 1 ? `New on 4flieks: ${films[0].title}` : `${n} new films on 4flieks this week`,
      preheader: films.map(f => f.title).join(' · ').slice(0, 140),
      kicker: 'New this week',
      heading: n === 1 ? `${films[0].title} is now showing` : `${n} new African films`,
      intro: n === 1 ? 'A new film arrived on 4flieks this week. Rent it for 48 hours or own it for good.'
        : 'Here\'s what arrived on 4flieks this week. Rent any of them for 48 hours or own them for good.',
      films: films.map(f => f.id), signoff: 'The 4flieks team'
    }),
    status: 'draft', created_at: now, created_by: 'weekly', week: wk
  };
  await ops.dbWrite(`flieks_crm/campaigns/${id}`, c);
  await ops.dbWrite(`flieks_crm/weekly/${wk}`, { campaign: id, films: c.films, at: now });
  return { made: true, id, week: wk, films: n };
}

/* ---------- access requests (POPIA s23) ---------- */

/** Everything we hold about one account, for answering "what do you have on me?". */
async function exportPerson(uid) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid || '')) throw new Error('bad uid');
  const user = await ops.dbGet(`flieks_users/${uid}`);
  if (!user) throw new Error('no such account');
  const email = str(user.email, 200);
  const ekey = wl.validEmail(email) ? wl.emailKey(email) : null;
  const mineOf = (node, deep = false) => ops.dbGet(node).then(all => {
    const out = {};
    for (const [k, v] of Object.entries(all || {})) {
      if (deep) { if (v && v[uid]) out[k] = v[uid]; continue; }
      if (v && typeof v === 'object' && (v.uid === uid || (email && String(v.email || '').toLowerCase() === email.toLowerCase()))) out[k] = v;
    }
    return out;
  }).catch(() => ({}));
  const [purchases, transactions, support, reviews, watchlist, follows, bank, prefs, log] = await Promise.all([
    ops.dbGet(`flieks_purchases/${uid}`), mineOf('flieks_transactions'), mineOf('flieks_support'), mineOf('flieks_reviews', true),
    ops.dbGet(`flieks_watchlist/${uid}`), ops.dbGet(`flieks_follows/${uid}`), ops.dbGet(`flieks_bank/${uid}`),
    ekey ? getPrefs(ekey) : null, ekey ? ops.dbGet(`flieks_crm/log/${ekey}`) : null
  ]);
  // Everything else stored under their account id, and records elsewhere that name them.
  const BY_UID = ['flieks_agreements', 'flieks_payouts', 'flieks_my_gifts', 'flieks_makers', 'flieks_talent', 'flieks_lab_usage',
    'flieks_lab_unlimited', 'flieks_script_reports_by_user', 'flieks_coach_by_user', 'flieks_board_my_apps', 'flieks_budgets',
    'flieks_budget_index', 'flieks_budget_versions', 'flieks_threads', 'flieks_thread_meta'];
  const SCANNED = ['flieks_filmmaker_applications', 'flieks_orders', 'flieks_gifts', 'flieks_board_posts', 'dd_orders', 'dd_gifts'];
  const more = {};
  await Promise.all([
    ...BY_UID.map(n => ops.dbGet(`${n}/${uid}`).then(v => { if (v != null) more[n.replace(/^flieks_/, '')] = v; }).catch(() => {})),
    ...SCANNED.map(n => mineOf(n).then(v => { if (Object.keys(v).length) more[n.replace(/^flieks_/, '')] = v; })),
    ops.dbGet('flieks_watch_emails').then(all => {
      const v = {};
      for (const [film, list] of Object.entries(all || {})) for (const [k, x] of Object.entries(list || {}))
        if (x && email && String(x.email || '').toLowerCase() === email.toLowerCase()) v[film] = { at: x.at || null };
      if (Object.keys(v).length) more.coming_soon_alerts = v;
    }).catch(() => {}),
    ekey ? ops.dbGet('flieks_crm/sends').then(all => {
      const v = {};
      for (const [cid, s] of Object.entries(all || {})) if (s && s[ekey]) v[cid] = s[ekey];
      if (Object.keys(v).length) more.marketing_emails_sent = v;
    }).catch(() => {}) : null
  ]);
  // Bank details: say we hold them, show only enough to recognise them.
  const bankShown = bank ? Object.fromEntries(Object.entries(bank).map(([k, v]) =>
    [k, /account|number|acc_no/i.test(k) && typeof v === 'string' ? '••••' + v.slice(-4) : v])) : null;
  return {
    generated_at: new Date().toISOString(), uid, account: user, purchases: purchases || {}, transactions, support_tickets: support,
    reviews, watchlist: watchlist || {}, following: follows || {}, bank_details: bankShown,
    email_preferences: prefs, email_preference_history: log || {}, other_records: more,
    notes: 'Card details are never received or stored by 4flieks (payments go to Yoco).'
  };
}

module.exports = {
  FIELDS, FIELD_NAMES, WORDING, SOURCES, AUDIENCES, AUDIENCE_FOR_KIND, KINDS,
  okKey, okId, newId, mask, prefsToken, checkToken, prefsUrl, oneClickUrl,
  getPrefs, setPref, isSale, newsStatus, people, audience, counts,
  cleanCampaign, filmsById, render, sendBatch, sendChunk, markFailed, rememberAddresses, emailForKey, customerKey, write, sendConfirm, runCampaign, startSend, jobSecret,
  weekKey, draftWeekly, exportPerson
};
