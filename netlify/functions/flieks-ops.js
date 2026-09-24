/**
 * flieks-ops — the control centre's back end. Admin only.
 *
 * POST { token, action }
 *   facts          what's happening now, plus the latest briefing
 *   briefing-now   write a fresh briefing (doesn't send it)
 *   ask            { question, history } — answer from live data
 *   test-message   send a test WhatsApp (or email, if WhatsApp isn't set up)
 */
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
