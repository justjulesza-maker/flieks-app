/**
 * flieks-email-prefs — anyone managing the email they get from 4flieks.
 *
 * With the link from an email (no sign-in), { k, t } prove it's their address:
 *   POST { action:'get', k, t }                       -> { email (masked), prefs, filmmaker }
 *   POST { action:'set', k, t, field, value, source }  field: news | filmmaker_news | alerts
 *   POST { action:'all-off', k, t, source }           unsubscribe from everything optional
 * Signed in, with a Firebase ID token instead of k/t:
 *   POST { action:'mine', token }                      same as get
 *   POST { action:'set' | 'all-off', token, ... }
 *   POST { action:'signup', token, news, source }      the box on the sign-up forms
 * Mail apps' one-click unsubscribe (RFC 8058):
 *   POST ?k=&t=&scope=  body "List-Unsubscribe=One-Click"
 *
 * Every change goes through crm.setPref, which logs the source and wording.
 */
const ops = require('../lib/ops-core');
const crm = require('../lib/crm');
const wl = require('../lib/watchlist');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u || !wl.validEmail(u.email || '')) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return { uid: u.localId, email: u.email, verified: !!u.emailVerified, name: u.displayName || profile.name || '', role: profile.role || 'viewer' };
}

/* Which source and wording a change from each place records. */
const WORDING_FOR = {
  'signup:home': 'signup-v1', 'signup:lab': 'signup-v1', 'signup:talent': 'signup-v1', 'signup:filmmaker': 'signup-filmmaker-v1',
  profile: 'profile-v1', 'consent-email': 'consent-email-v1', 'confirm-email': 'confirm-email-v1', 'prefs-page': 'prefs-page-v1',
  'unsubscribe-link': 'unsubscribe-link-v1', 'one-click': 'one-click-v1'
};
const PUBLIC_SOURCES = ['profile', 'consent-email', 'confirm-email', 'prefs-page', 'unsubscribe-link'];

async function view(ekey, who) {
  const prefs = (await crm.getPrefs(ekey)) || {};
  const found = who || (prefs.email && prefs.uid) ? null : await crm.emailForKey(ekey);
  const email = (who && who.email) || prefs.email || (found && found.email) || '';
  let role = who && who.role;
  const uid = (who && who.uid) || prefs.uid || (found && found.uid);
  if (!role && uid) role = ((await ops.dbGet(`flieks_users/${uid}`)) || {}).role;
  // Same rule as the CRM: a customer if any account on this address bought.
  const buyer = await crm.customerKey(ekey);
  const ns = crm.newsStatus(prefs, buyer);
  return {
    ok: true, email: who ? email : crm.mask(email),
    prefs: {
      news: ns.eligible,                                   // what they get now
      news_chosen: prefs.news === undefined ? null : prefs.news,
      news_basis: ns.basis,
      news_pending: !!(prefs.news_pending && prefs.news !== true),
      filmmaker_news: prefs.filmmaker_news !== false,
      alerts: prefs.alerts !== false
    },
    filmmaker: role === 'filmmaker' || role === 'filmmaker_pending'
  };
}

exports.handler = async event => {
  const q = event.queryStringParameters || {};

  /* One-click unsubscribe from a mail app. No JSON, no page. */
  // Any POST to the link in the List-Unsubscribe header counts: mail apps send the body in
  // different encodings (RFC 8058 allows form-data), and the page itself never posts here with these.
  if (event.httpMethod === 'POST' && q.k && q.t && q.scope) {
    if (!crm.checkToken(q.k, q.t)) return { statusCode: 403, body: 'Link not valid' };
    const field = crm.FIELDS.includes(q.scope) ? q.scope : 'news';
    const found = await crm.emailForKey(q.k);
    const email = found && found.email;
    if (email) await crm.setPref({ email, field, value: false, source: 'one-click', wording: 'one-click-v1' });
    else await ops.dbWrite(`flieks_crm/prefs/${q.k}`, { [field]: false, updated_at: Date.now() }, 'PATCH');
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Unsubscribed' };
  }
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  const a = b.action;

  try {
    /* Who is asking: a signed-in person, or someone holding the link from an email. */
    let who = null, ekey = null;
    if (b.token) {
      who = await lookup(b.token);
      if (!who) return reply(401, { message: 'Please sign in again.' });
      ekey = wl.emailKey(who.email);
    } else if (b.k || b.t) {
      if (!crm.checkToken(b.k, b.t)) return reply(403, { message: 'This link is not valid. Open the latest email from us, or sign in.' });
      ekey = b.k;
    } else return reply(401, { message: 'Sign in, or use the link in one of our emails.' });

    const prefs = (await crm.getPrefs(ekey)) || {};
    let email = (who && who.email) || prefs.email;
    if (!email && a !== 'get') { const f = await crm.emailForKey(ekey); email = f && f.email; }

    if (a === 'get' || a === 'mine') return reply(200, await view(ekey, who));

    if (a === 'signup') {
      if (!who) return reply(401, { message: 'Sign in first.' });
      const source = String(b.source || '');
      if (!source.startsWith('signup:') || !WORDING_FOR[source]) return reply(400, { message: 'Bad request.' });
      // Only a tick is a yes. An unticked box means they didn't choose, not a no, so it
      // records nothing; a buyer can still get customer mail until they say no.
      if (b.news === true && prefs.news == null) {
        // Nobody has proved they own this address yet: hold the yes until they confirm by email.
        if (!who.verified) {
          const r = await crm.sendConfirm({ email, uid: who.uid, name: who.name, source, wording: WORDING_FOR[source] });
          return reply(200, { ok: true, pending: true, sent: !!r.ok });
        }
        await crm.setPref({ email, uid: who.uid, field: 'news', value: true, source, wording: WORDING_FOR[source], onlyIfUnset: true });
      } else if (!prefs.uid) {
        await ops.dbWrite(`flieks_crm/prefs/${ekey}`, { email, uid: who.uid, updated_at: Date.now() }, 'PATCH');
      }
      return reply(200, { ok: true });
    }

    if (!email) return reply(404, { message: 'We don\'t have this address any more.' });

    if (a === 'set') {
      const field = b.field, value = b.value;
      if (!crm.FIELDS.includes(field) || typeof value !== 'boolean') return reply(400, { message: 'Bad request.' });
      const source = PUBLIC_SOURCES.includes(b.source) ? b.source : 'prefs-page';
      // Signed in but the address isn't verified: a yes to news waits for the confirm email.
      // (The link from an email proves the inbox, so that path saves straight away.)
      if (who && !who.verified && field === 'news' && value === true && prefs.news !== true) {
        const r = await crm.sendConfirm({ email, uid: who.uid, name: who.name, source, wording: WORDING_FOR[source] });
        return reply(200, { ...(await view(ekey, who)), pending: true, sent: !!r.ok });
      }
      await crm.setPref({ email, uid: who ? who.uid : null, field, value, source, wording: WORDING_FOR[source] });
      return reply(200, await view(ekey, who));
    }

    if (a === 'all-off') {
      const source = PUBLIC_SOURCES.includes(b.source) ? b.source : 'prefs-page';
      for (const field of crm.FIELDS) await crm.setPref({ email, uid: who ? who.uid : null, field, value: false, source, wording: WORDING_FOR[source] });
      return reply(200, await view(ekey, who));
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[email-prefs]', a, e);
    return reply(500, { message: 'Something went wrong. Please try again.' });
  }
};
