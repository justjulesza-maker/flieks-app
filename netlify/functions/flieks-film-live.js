/**
 * flieks-film-live — email the filmmaker when their film goes live. Admin only.
 *
 * POST { token, filmId, force? }
 *   Sends once per film. force:true sends it again (the admin "Send go-live
 *   email" button).
 *   -> { ok, to, already? } or { ok:false, reason }
 */
const ops = require('../lib/ops-core');
const { sendLiveEmail } = require('../lib/film-mail');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  try {
    const { token, filmId, force } = JSON.parse(event.body || '{}');
    const admin = await ops.verifyAdmin(token);
    if (!admin) return reply(403, { message: 'Admin only.' });
    const r = await sendLiveEmail(String(filmId || ''), { force: !!force });
    console.log('[film-live]', filmId, r.ok ? (r.already ? 'already sent' : 'sent') : r.reason);
    return reply(200, r);
  } catch (e) {
    console.error('[film-live]', e);
    return reply(500, { ok: false, reason: 'Could not send the email.' });
  }
};
