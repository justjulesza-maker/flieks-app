/**
 * flieks-messages — conversations between the 4flieks team and each filmmaker.
 *
 * One thread per filmmaker. A message from 4flieks is emailed to the filmmaker
 * and waits in "Messages from 4flieks" in their portal; their reply is emailed
 * to the team and shows in admin, so the whole conversation stays in one place.
 *
 *   flieks_threads/{makerUid}/{msgId}  { from: 'admin'|'maker', by, body, film_id, film_title, at }
 *   flieks_thread_meta/{makerUid}      { name, email, last_at, last_from, last_body, unread_admin, unread_maker }
 *
 * POST { token, action, ... }
 *   admin:     threads | thread { uid } | send { uid, body, filmId? }
 *   filmmaker: mine | reply { body } | unread
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');

const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const okUid = u => typeof u === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TEAM = () => process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL;

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return { uid: u.localId, email: u.email || '', role: profile.role || 'viewer', name: profile.name || u.displayName || '' };
}

function mailHtml(heading, body, cta, url, foot) {
  return `<!doctype html><html><body style="margin:0;background:#F2EADA"><div style="max-width:560px;margin:0 auto;padding:28px 18px;font-family:Arial,Helvetica,sans-serif;color:#1C1512">
  <div style="background:#1C1512;border-radius:14px;padding:20px 22px"><img src="${ops.SITE}/brand/png/logo-reversed-2x.png" width="200" alt="4flieks" style="display:block;width:200px;height:auto;border:0"></div>
  <h1 style="font-size:22px;margin:24px 0 12px">${escHtml(heading)}</h1>
  <div style="background:#FBF6EC;border:1px solid #DCCFB9;border-radius:12px;padding:16px 18px;font-size:16px;line-height:1.55;white-space:pre-line">${escHtml(body)}</div>
  <p style="margin:22px 0"><a href="${escHtml(url)}" style="display:inline-block;padding:13px 22px;border-radius:10px;font:700 15px Arial;text-decoration:none;background:#D85A2C;color:#1C1512">${escHtml(cta)}</a></p>
  <p style="font-size:13px;color:#6E6157">${escHtml(foot)}</p></div></body></html>`;
}

async function listThread(uid) {
  const all = await ops.dbGet(`flieks_threads/${uid}`) || {};
  return Object.entries(all).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.at || 0) - (b.at || 0));
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  try {
    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Please sign in.' });
    const a = b.action;

    /* ---------- the team ---------- */
    if (a === 'threads' || a === 'thread' || a === 'send') {
      if (me.role !== 'admin') return reply(403, { message: 'Admin only.' });
      if (a === 'threads') {
        const meta = await ops.dbGet('flieks_thread_meta') || {};
        return reply(200, { threads: Object.entries(meta).map(([uid, m]) => ({ uid, ...m })).sort((x, y) => (y.last_at || 0) - (x.last_at || 0)) });
      }
      if (!okUid(b.uid)) return reply(400, { message: 'Which filmmaker?' });
      const user = await ops.dbGet(`flieks_users/${b.uid}`);
      if (!user) return reply(404, { message: 'No such account.' });
      if (a === 'thread') {
        await ops.dbWrite(`flieks_thread_meta/${b.uid}/unread_admin`, 0).catch(() => {});
        return reply(200, { name: user.name || user.email || '', email: user.email || '', messages: await listThread(b.uid) });
      }
      // send
      const body = str(b.body, 3000);
      if (body.length < 2) return reply(400, { message: 'Write the message first.' });
      let film = null;
      if (b.filmId && /^[A-Za-z0-9_-]{1,120}$/.test(b.filmId)) film = await ops.dbGet(`flieks_films/${b.filmId}`);
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const msg = { from: 'admin', by: me.name || '4flieks', body, film_id: film ? b.filmId : null, film_title: film ? film.title || null : null, at: Date.now() };
      await ops.dbWrite(`flieks_threads/${b.uid}/${id}`, msg);
      const meta = await ops.dbGet(`flieks_thread_meta/${b.uid}`) || {};
      await ops.dbWrite(`flieks_thread_meta/${b.uid}`, { name: user.name || '', email: user.email || '', last_at: msg.at, last_from: 'admin',
        last_body: body.slice(0, 140), unread_admin: 0, unread_maker: (meta.unread_maker || 0) + 1 });
      let emailed = false;
      if (user.email) {
        const subject = film ? `A message from 4flieks about ${film.title}` : 'A message from the 4flieks team';
        const url = `${ops.SITE}/filmmaker#messages`;
        const r = await ops.sendEmailTo({ to: user.email, subject, replyTo: TEAM(),
          text: `Hi ${(user.name || '').split(' ')[0] || 'there'},\n\n${body}\n\n— ${msg.by}, 4flieks\n\nReply in your filmmaker portal: ${url}\n(or just reply to this email)`,
          html: mailHtml(subject, `${body}\n\n— ${msg.by}, 4flieks`, 'Reply in your portal', url, 'You can also just reply to this email.') }).catch(() => ({ ok: false }));
        emailed = !!r.ok;
      }
      return reply(200, { ok: true, emailed, message: { id, ...msg } });
    }

    /* ---------- the filmmaker ---------- */
    if (a === 'mine' || a === 'reply' || a === 'unread') {
      if (a === 'unread') {
        const meta = await ops.dbGet(`flieks_thread_meta/${me.uid}`) || {};
        return reply(200, { unread: meta.unread_maker || 0 });
      }
      if (a === 'mine') {
        await ops.dbWrite(`flieks_thread_meta/${me.uid}/unread_maker`, 0).catch(() => {});
        return reply(200, { messages: await listThread(me.uid) });
      }
      const body = str(b.body, 3000);
      if (body.length < 2) return reply(400, { message: 'Write your reply first.' });
      const day = new Date().toISOString().slice(0, 10);
      if (!(await ops.takeSlot(`flieks_ops/reply_rate/${me.uid}/${day}`, 30).catch(() => true))) {
        return reply(429, { message: 'That is a lot of messages today. The team will get back to you; try again tomorrow.' });
      }
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const msg = { from: 'maker', by: me.name || me.email, body, film_id: null, film_title: null, at: Date.now() };
      await ops.dbWrite(`flieks_threads/${me.uid}/${id}`, msg);
      const meta = await ops.dbGet(`flieks_thread_meta/${me.uid}`) || {};
      await ops.dbWrite(`flieks_thread_meta/${me.uid}`, { name: me.name || '', email: me.email, last_at: msg.at, last_from: 'maker',
        last_body: body.slice(0, 140), unread_admin: (meta.unread_admin || 0) + 1, unread_maker: 0 });
      if (TEAM()) await ops.sendEmailTo({ to: TEAM(), replyTo: me.email, subject: `${me.name || me.email} replied on 4flieks`,
        text: `${me.name || me.email} (${me.email}) wrote:\n\n${body}\n\nOpen the conversation: ${ops.SITE}/admin#messages`,
        html: mailHtml(`${me.name || me.email} replied`, body, 'Open in admin', `${ops.SITE}/admin#messages`, `Reply there, or reply to this email to write to ${me.email} directly.`) }).catch(() => {});
      return reply(200, { ok: true, message: { id, ...msg } });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[messages]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
