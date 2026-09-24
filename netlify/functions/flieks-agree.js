/**
 * flieks-agree — records a filmmaker accepting the distribution agreement.
 *
 * Recorded here rather than in the browser so the timestamp, the IP and the
 * version of the terms cannot be set by whoever is signing. If this is ever
 * disputed, the record has to have come from us.
 *
 * Accepted once, covering the relationship. Each film added afterwards is a
 * schedule under it — asking someone to sign again for every short film would
 * be tedious and nobody would read it the second time.
 *
 * POST { token, action }
 *   status                          have I accepted, and is it current
 *   accept { fullName, capacity }   record acceptance
 *   signed { url }                  note that a countersigned PDF was uploaded
 *   send-copy { uid }               admin: email that filmmaker their record again
 *
 * On accepting, the filmmaker is emailed their record (reference, version,
 * name as signed, date) with the agreement PDF attached, copied to Julian.
 */
const https = require('https');
const crypto = require('crypto');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

/* Bump this when the agreement changes materially. Anyone on an older version
   is asked to accept again rather than being silently bound to new terms. */
const VERSION = '2026-09-12';

const { sendEmailTo } = require('../lib/ops-core');
const SITE = 'https://4flieks.com';
const PDF_URL = `${SITE}/Filmmaker-Distribution-Agreement.pdf`;
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* The filmmaker's copy of what they accepted. The record in the database is
   the evidence; this is so they (and we) have it in an inbox too. */
function agreementEmail(rec) {
  const when = new Date(rec.accepted_at).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const first = String(rec.full_name || '').split(/\s+/)[0] || 'there';
  const rows = [
    ['Reference', rec.reference],
    ['Agreement version', rec.version],
    ['Accepted by', rec.full_name + (rec.capacity ? `, ${rec.capacity}` : '')],
    ['Accepted on', when + ' (SAST)'],
    ['Email', rec.email]
  ];
  const terms = [
    'You keep 70% of net revenue on every sale.',
    'Non-exclusive: you can sell the film anywhere else too.',
    'You keep the copyright, always.',
    'Either side can end it on 30 days’ notice.',
    'Each film you add is covered by this agreement. No need to sign again.'
  ];
  const subject = `Your 4flieks distribution agreement (${rec.reference})`;
  const text = [
    `Hi ${first},`, '',
    'Thank you for accepting the 4flieks Filmmaker Distribution Agreement. Keep this email as your record.', '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '',
    'In short:', ...terms.map(t => `- ${t}`), '',
    `The full agreement is attached, and always available at ${PDF_URL}`, '',
    'Questions? Just reply to this email.', '',
    'Julian and the 4flieks team',
    'DiscovrTV (Pty) Ltd trading as 4flieks'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F2EADA">
<div style="max-width:560px;margin:0 auto;padding:28px 18px;font-family:Arial,Helvetica,sans-serif;color:#1C1512">
  <div style="background:#1C1512;border-radius:14px;padding:22px">
    <img src="${SITE}/brand/png/logo-reversed-2x.png" width="260" alt="4flieks" style="display:block;width:260px;height:auto;border:0">
  </div>
  <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#B0441A;font-weight:700;margin:26px 0 6px">Distribution agreement</p>
  <h1 style="font-size:26px;line-height:1.2;margin:0 0 14px">Your copy, ${escHtml(first)}</h1>
  <p style="font-size:16px;line-height:1.55;margin:0 0 18px">Thank you for accepting the 4flieks Filmmaker Distribution Agreement. Keep this email as your record. The full agreement is attached.</p>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#FBF6EC;border:1px solid #DCCFB9;border-radius:12px;margin:0 0 20px">
    ${rows.map(([k, v]) => `<tr><td style="padding:10px 16px;font-size:14px;color:#6E6157;width:40%;border-bottom:1px solid #EAE0CE">${escHtml(k)}</td><td style="padding:10px 16px;font-size:14px;font-weight:700;border-bottom:1px solid #EAE0CE">${escHtml(v)}</td></tr>`).join('')}
  </table>
  <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#B0441A;font-weight:700;margin:0 0 8px">In short</p>
  <ul style="font-size:15px;line-height:1.6;color:#54483F;margin:0 0 20px;padding-left:20px">${terms.map(t => `<li>${escHtml(t)}</li>`).join('')}</ul>
  <p style="font-size:14px;line-height:1.5;color:#54483F;margin:0 0 24px">Can't open the attachment? <a href="${PDF_URL}" style="color:#B0441A">Read the agreement online</a>. Questions? Just reply to this email.</p>
  <p style="font-size:15px;margin:0">Julian and the 4flieks team</p>
  <p style="font-size:13px;color:#6E6157;margin:4px 0 0">DiscovrTV (Pty) Ltd trading as 4flieks · <a href="${SITE}" style="color:#6E6157">4flieks.com</a></p>
</div></body></html>`;
  return { subject, text, html };
}

async function emailAgreementCopy(rec) {
  if (!rec || !rec.email) return { ok: false, reason: 'no email address on the agreement' };
  const r = await sendEmailTo({
    to: rec.email,
    cc: process.env.OPS_EMAIL_TO || null,
    replyTo: process.env.SUPPORT_EMAIL || 'support@4flieks.com',
    attachments: [{ filename: `4flieks-Distribution-Agreement-${rec.version}.pdf`, path: PDF_URL }],
    ...agreementEmail(rec)
  });
  await patch(`flieks_agreements/${rec.uid}`, {
    copy_emailed_at: Date.now(), copy_email_status: r.ok ? 'sent' : (r.reason || 'failed')
  });
  return r;
}

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

const get = async p => JSON.parse((await request(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const put = (p, data) => {
  const b = JSON.stringify(data);
  return request(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};
const patch = (p, data) => {
  const b = JSON.stringify(data);
  return request(`${DB}/${p}.json?auth=${SECRET}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};

async function verifyToken(token) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set.');
  const b = JSON.stringify({ idToken: token });
  const r = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { token, action } = JSON.parse(event.body || '{}');
    if (!token) return reply(401, { message: 'Please sign in.' });

    const user = await verifyToken(token);
    const uid = user.localId;
    const existing = await get(`flieks_agreements/${uid}`);

    /* ---- where do I stand ---- */
    if (action === 'status' || !action) {
      const current = !!(existing && existing.version === VERSION);
      return reply(200, {
        accepted: !!existing,
        current,
        version: VERSION,
        acceptedVersion: existing ? existing.version : null,
        acceptedAt: existing ? existing.accepted_at : null,
        name: existing ? existing.full_name : '',
        reference: existing ? existing.reference : null,
        hasSignedPdf: !!(existing && existing.signed_pdf_url)
      });
    }

    /* ---- accept it ---- */
    if (action === 'accept') {
      const { fullName, capacity } = JSON.parse(event.body || '{}');
      const name = String(fullName || '').trim().slice(0, 90);
      if (name.length < 3 || !name.includes(' ')) {
        return reply(400, { message: 'Please type your full name as you would sign it.' });
      }

      const h = event.headers || {};
      const ip = (h['x-nf-client-connection-ip'] ||
                  (h['x-forwarded-for'] || '').split(',')[0] || '').trim();

      const reference = 'DA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const now = Date.now();

      await put(`flieks_agreements/${uid}`, {
        uid,
        reference,
        version: VERSION,
        full_name: name,
        capacity: String(capacity || '').trim().slice(0, 80),
        email: user.email || '',
        accepted_at: now,
        // Kept as evidence that the acceptance came from a real session.
        ip,
        user_agent: String(h['user-agent'] || '').slice(0, 200),
        method: 'electronic',
        // Carried over if they had signed a previous version.
        signed_pdf_url: (existing && existing.signed_pdf_url) || null
      });

      // So the admin user list shows it without a second lookup.
      await patch(`flieks_users/${uid}`, {
        agreement_version: VERSION,
        agreement_at: now,
        agreement_ref: reference
      });

      console.log(`Agreement accepted: ${uid} ${name} ${reference} v${VERSION}`);

      // Their copy by email. Never blocks the acceptance itself.
      let emailed = false;
      try {
        const rec = await get(`flieks_agreements/${uid}`);
        const r = await emailAgreementCopy(rec);
        emailed = r.ok;
        if (!r.ok) console.warn('agreement copy not sent:', r.reason);
      } catch (e) { console.warn('agreement copy failed:', e.message); }

      return reply(200, { ok: true, reference, version: VERSION, acceptedAt: now, emailed });
    }

    /* ---- admin: email a filmmaker their record (again) ---- */
    if (action === 'send-copy') {
      const me = await get(`flieks_users/${uid}`);
      if (!me || me.role !== 'admin') return reply(403, { message: 'Admin only.' });
      const target = String(JSON.parse(event.body || '{}').uid || '');
      if (!target || /[.#$\[\]\/]/.test(target)) return reply(400, { message: 'No filmmaker.' });
      const rec = await get(`flieks_agreements/${target}`);
      if (!rec) return reply(404, { message: 'That filmmaker has not accepted the agreement.' });
      const r = await emailAgreementCopy({ uid: target, ...rec });
      return reply(r.ok ? 200 : 502, r.ok ? { ok: true, to: rec.email } : { message: r.reason || 'Could not send.' });
    }

    /* ---- they uploaded a countersigned copy as well ---- */
    if (action === 'signed') {
      const { url } = JSON.parse(event.body || '{}');
      if (!url || !/^https:\/\//.test(url)) return reply(400, { message: 'No file.' });
      if (!existing) return reply(400, { message: 'Accept the agreement first.' });
      await patch(`flieks_agreements/${uid}`, {
        signed_pdf_url: url, signed_pdf_at: Date.now()
      });
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });

  } catch (e) {
    console.error('agreement error:', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
