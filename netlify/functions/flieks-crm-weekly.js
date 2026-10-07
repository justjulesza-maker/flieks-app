/**
 * flieks-crm-weekly — Monday morning: draft "new on 4flieks this week" from the
 * films that went live in the last 7 days, and tell Julian it's waiting at /crm.
 * It never sends: an admin checks it and presses Send. Weeks with no new films
 * are skipped. Scheduled in netlify.toml; takes no input.
 */
const ops = require('../lib/ops-core');
const crm = require('../lib/crm');

exports.handler = async () => {
  try {
    const r = await crm.draftWeekly();
    console.log('[crm-weekly]', JSON.stringify(r));
    if (r.made) {
      const to = process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL;
      if (to) await ops.sendEmailTo({
        to, subject: `Weekly 4flieks mail ready: ${r.films} new film${r.films === 1 ? '' : 's'}`,
        text: `This week's "new on 4flieks" email is drafted with ${r.films} new film${r.films === 1 ? '' : 's'}.\n\nIt hasn't been sent. Check it and press Send:\n${ops.SITE}/crm#c=${r.id}`
      });
    }
  } catch (e) { console.error('[crm-weekly]', e); }
  return { statusCode: 200, body: 'ok' };
};
