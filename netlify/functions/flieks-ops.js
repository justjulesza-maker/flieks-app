/**
 * flieks-ops — the control centre's back end. Admin only.
 *
 * POST { token, action }
 *   facts          what's happening now, plus the latest briefing
 *   briefing-now   write a fresh briefing (doesn't send it)
 *   ask            { question, history } — answer from live data
 *   test-message   send a test WhatsApp (or email, if WhatsApp isn't set up)
 *   lab-festivals  add festival picks to Script Reports written before they existed
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  try {
    const { token, action, question, history } = JSON.parse(event.body || '{}');
    const admin = await ops.verifyAdmin(token);
    if (!admin) return reply(403, { message: 'Admin only.' });

    if (action === 'facts') {
      const [facts, latest] = await Promise.all([
        ops.buildFacts(),
        ops.dbGet('flieks_ops/briefings/latest').catch(() => null)
      ]);
      delete facts.alertKeys;
      return reply(200, { facts, briefing: latest, channels: ops.channelStatus() });
    }

    if (action === 'briefing-now') {
      const facts = await ops.buildFacts();
      let b;
      try { b = await ops.writeBriefing(facts); }
      catch (e) { b = { headline: ops.fallbackHeadline(facts), briefing: `(The assistant couldn't write a briefing: ${e.message})` }; }
      const rec = { ...b, at: Date.now() };
      await ops.dbWrite('flieks_ops/briefings/latest', rec);
      return reply(200, { briefing: rec });
    }

    if (action === 'ask') {
      if (!question || !String(question).trim()) return reply(400, { message: 'Ask something.' });
      const facts = await ops.buildFacts({ verifyPayments: false });
      const text = await ops.answer(facts, question, history);
      return reply(200, { answer: text });
    }

    if (action === 'lab-festivals') {
      const st = await ops.dbGet('flieks_ops/festival_backfill').catch(() => null);
      if (st && (st.status === 'working' || st.status === 'queued') && Date.now() - (st.started_at || 0) < 16 * 60e3) {
        return reply(200, { running: true, total: st.total, done: st.done });
      }
      const all = await ops.dbGet('flieks_script_reports') || {};
      const todo = Object.values(all).filter(r => r && r.status === 'done' && r.report && !Array.isArray(r.report.festivals)).length;
      if (!todo) return reply(200, { total: 0 });
      await ops.dbWrite('flieks_ops/festival_backfill', { status: 'queued', total: todo, done: 0, failed: 0, started_at: Date.now() });
      const secret = crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':festivals').digest('hex');
      const base = process.env.URL || 'https://4flieks.com';
      const kick = await fetch(`${base}/.netlify/functions/festivals-background`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-job-secret': secret }, body: '{}'
      }).catch(() => ({ ok: false, status: 0 }));
      if (!kick.ok && kick.status !== 202) return reply(502, { message: 'Could not start the update. Try again.' });
      return reply(200, { started: true, total: todo });
    }

    if (action === 'lab-festivals-status') {
      return reply(200, { status: await ops.dbGet('flieks_ops/festival_backfill').catch(() => null) });
    }

    if (action === 'test-message') {
      const r = await ops.notify('briefing', 'Test from your 4flieks control centre — messages are working',
        'This is a test. Your morning briefing will arrive around 07:00, and urgent alerts as they happen.');
      return reply(r.ok ? 200 : 500, r.ok ? { ok: true, via: r.via, note: r.whatsapp || null } : { message: r.reason });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[ops]', e);
    return reply(500, { message: 'Something went wrong: ' + e.message });
  }
};
