/**
 * flieks-support — receives a support message.
 *
 * The ticket is written to the database first and emailed second. If the mail
 * fails, the message is still recorded and visible in admin — a support system
 * that can silently lose a message from someone who has paid is worse than
 * none at all.
 *
 * Anything the person is signed in for is attached automatically: their
 * purchases, their recent transactions. Most tickets can then be answered
 * without a round of questions.
 *
 * POST { email, topic, body, token? } -> { ok, ref }
 */
const https = require('https');
const crypto = require('crypto');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

const SUPPORT_TO = process.env.SUPPORT_EMAIL || 'support@4flieks.com';

function request(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const dbGet = async p => JSON.parse((await request(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const dbPut = (p, data) => {
  const b = JSON.stringify(data);
  return request(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function whoIs(token) {
  if (!token || !API_KEY) return null;
  try {
    const b = JSON.stringify({ idToken: token });
    const r = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
    }, b);
    const d = JSON.parse(r.body || '{}');
    return (d.users && d.users[0]) || null;
  } catch { return null; }
}

const clean = (s, max) => String(s || '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .trim().slice(0, max);

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

/* Sends through Resend when configured. Everything still works without it —
   the ticket is in the database either way and shows up in admin. */
async function sendMail(subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, why: 'no mail service configured' };

  const body = JSON.stringify({
    from: process.env.SUPPORT_FROM || '4flieks <support@4flieks.com>',
    to: [SUPPORT_TO],
    subject,
    text
  });

  try {
    const r = await request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);
    return { sent: r.status < 300, why: r.status < 300 ? '' : r.body };
  } catch (e) {
    return { sent: false, why: e.message };
  }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const p = JSON.parse(event.body || '{}');
    const email = clean(p.email, 120);
    const topic = clean(p.topic, 60);
    const body  = clean(p.body, 1500);

    if (!/^\S+@\S+\.\S+$/.test(email)) return reply(400, { message: 'That email does not look right.' });
    if (body.length < 10) return reply(400, { message: 'Tell us a little more.' });

    const user = await whoIs(p.token);

    /* Attach what we already know, so the reply can be the first message
       rather than a request for details. */
    let context = null;
    if (user) {
      const [purchases, txs] = await Promise.all([
        dbGet(`flieks_purchases/${user.localId}`),
        dbGet('flieks_transactions')
      ]);

      const mine = Object.entries(txs || {})
        .filter(([, t]) => t && t.uid === user.localId)
        .sort((a, b) => (b[1].created_at || 0) - (a[1].created_at || 0))
        .slice(0, 5)
        .map(([id, t]) => ({
          id, film: t.film_title, type: t.type,
          total: t.total, status: t.status, mode: t.mode || 'live',
          at: t.completed_at || t.created_at
        }));

      context = {
        uid: user.localId,
        account_email: user.email || '',
        owns: Object.entries(purchases || {}).map(([filmId, x]) => ({
          filmId, type: x.type, expires_at: x.expires_at || null
        })),
        recent_transactions: mine
      };
    }

    const ref = 'S-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const now = Date.now();

    await dbPut(`flieks_support/${ref}`, {
      ref, email, topic, body,
      uid: user ? user.localId : null,
      context,
      status: 'open',
      created_at: now
    });

    // Everything we know, laid out so a reply can be written straight away.
    const lines = [
      `${topic}`,
      `From: ${email}`,
      `Reference: ${ref}`,
      ``,
      body,
      ``,
      `───────────────`
    ];

    if (context) {
      lines.push(`Signed in as ${context.account_email} (${context.uid})`);
      if (context.owns.length) {
        lines.push(``, `Owns:`);
        context.owns.forEach(o => lines.push(
          `  ${o.filmId} — ${o.type}${o.expires_at
            ? `, expires ${new Date(o.expires_at).toLocaleString('en-ZA')}`
            : o.type === 'rent' ? ', not started' : ''}`));
      } else {
        lines.push(``, `No purchases on this account.`);
      }
      if (context.recent_transactions.length) {
        lines.push(``, `Recent payments:`);
        context.recent_transactions.forEach(t => lines.push(
          `  ${t.id} — ${t.film || '?'} ${t.type} R${t.total} ${t.status}` +
          `${t.mode === 'test' ? ' [TEST]' : ''} ${t.at ? new Date(t.at).toLocaleString('en-ZA') : ''}`));
      }
    } else {
      lines.push(`Not signed in — no account details available.`);
    }

    lines.push(``, `Admin: https://4flieks.com/admin`);

    const mail = await sendMail(`[${ref}] ${topic} — 4flieks support`, lines.join('\n'));
    if (!mail.sent) console.warn('support email not sent:', mail.why, '— ticket saved as', ref);

    console.log(`Support ticket ${ref} from ${email}: ${topic}`);
    return reply(200, { ok: true, ref });

  } catch (e) {
    console.error('support error:', e);
    return reply(500, { message: 'Could not send that.' });
  }
};
