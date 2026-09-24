/**
 * flieks-ops-daily — the morning briefing. Scheduled in netlify.toml for
 * 05:00 UTC (07:00 in Johannesburg).
 *
 * Works out what happened, has the assistant write it up, keeps it for the
 * control centre, and sends Julian the headline and a link (WhatsApp, or
 * email if WhatsApp isn't set up). If the assistant is unavailable, the
 * numbers still go out with a plain headline.
 */
const ops = require('../lib/ops-core');

exports.handler = async () => {
  try {
    const facts = await ops.buildFacts();
    let b;
    try { b = await ops.writeBriefing(facts); }
    catch (e) {
      console.error('[ops-daily] briefing failed:', e.message);
      b = { headline: ops.fallbackHeadline(facts), briefing: ops.fallbackHeadline(facts) };
    }
    const at = Date.now();
    const day = new Date(ops.dayStart(at) + ops.SA).toISOString().slice(0, 10);
    const rec = { ...b, at };
    await Promise.all([
      ops.dbWrite('flieks_ops/briefings/latest', rec),
      ops.dbWrite(`flieks_ops/briefings/${day}`, rec)
    ]);
    const sent = await ops.notify('briefing', b.headline, b.briefing);
    console.log('[ops-daily] sent:', JSON.stringify(sent));
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('[ops-daily]', e);
    return { statusCode: 500, body: e.message };
  }
};
